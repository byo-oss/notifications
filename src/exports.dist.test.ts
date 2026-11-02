// A static scan of the built package. Run with `bun run test:dist` after
// `bun run build`. A missing `dist/` fails, it never skips.
//
// The scan parses the built files with TypeScript's parser instead of
// matching text, so a package name in a comment, a string or an error message
// is not an import.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

type Reference = {
  file: string;
  specifier: string;
  /** `static`: `import`/`export ... from`/`require`. `dynamic`: `import()`. */
  kind: "static" | "dynamic";
};

/** Every module reference in one file's source. */
function referencesIn(file: string, source: string): Reference[] {
  const found: Reference[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literal = (node: ts.Node | undefined) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== undefined) {
        found.push({ file, specifier, kind: "static" });
      }
    } else if (ts.isCallExpression(node)) {
      const first = literal(node.arguments[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found.push({ file, specifier: first ?? "<computed>", kind: "dynamic" });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        first !== undefined
      ) {
        found.push({ file, specifier: first, kind: "static" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every reference reachable from `entry` through local files, the entry included. */
function reachable(entry: string): Reference[] {
  const seen = new Set<string>();
  const references: Reference[] = [];
  const queue = [join(dist, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    expect(existsSync(file), `${relative(root, file)} is missing`).toBe(true);
    const source = readFileSync(file, "utf8");
    for (const ref of referencesIn(relative(root, file), source)) {
      references.push(ref);
      if (ref.specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), ref.specifier));
      }
    }
  }
  return references;
}

const matches = (specifier: string, packages: readonly string[]) =>
  packages.some((p) => specifier === p || specifier.startsWith(`${p}/`));

/** What `entry` reaches of `packages`, as `kind specifier in file`. */
const reaches = (
  entry: string,
  packages: readonly string[],
  kind?: Reference["kind"],
) =>
  reachable(entry)
    .filter((ref) => matches(ref.specifier, packages))
    .filter((ref) => !kind || ref.kind === kind)
    .map((ref) => `${ref.kind} ${ref.specifier} in ${ref.file}`);

const MAILER = ["@byo-oss/mailer"] as const;
const WRAPS_SDK = ["@wraps.dev/email"] as const;
// what loading the plugin pulls in: the event code imports it at runtime
const BETTER_AUTH = ["better-auth", "@better-auth/core"] as const;

describe("the scanner", () => {
  it("finds imports, requires and dynamic imports, not comments or strings", () => {
    const refs = referencesIn(
      "fixture.js",
      `// import "@byo-oss/mailer";
       import a from "kept-a";
       export { b } from "kept-b";
       const c = require("kept-c");
       const d = () => import("kept-d");
       const e = 'import x from "@wraps.dev/email"';`,
    ).map((r) => `${r.kind}:${r.specifier}`);
    expect(refs.sort()).toEqual(
      ["static:kept-a", "static:kept-b", "static:kept-c", "dynamic:kept-d"].sort(),
    );
  });
});

describe("only the ./mailer entry loads @byo-oss/mailer", () => {
  it.each([
    "index.js",
    "index.cjs",
    "client.js",
    "client.cjs",
    "react/index.js",
    "react/index.cjs",
    "wraps.js",
    "wraps.cjs",
    "testing.js",
  ])("%s reaches no @byo-oss/mailer", (entry) => {
    expect(reaches(entry, MAILER)).toEqual([]);
  });

  it.each(["mailer.js", "mailer.cjs"])(
    "%s imports @byo-oss/mailer, as an external, and no provider SDK",
    (entry) => {
      expect(reaches(entry, MAILER, "static").length).toBeGreaterThan(0);
      expect(reaches(entry, MAILER, "dynamic")).toEqual([]);
      expect(reaches(entry, WRAPS_SDK)).toEqual([]);
    },
  );
});

describe("the provider SDK stays optional", () => {
  it.each(["index.js", "index.cjs", "mailer.js", "mailer.cjs"])(
    "%s doesn't reach @wraps.dev/email",
    (entry) => {
      expect(reaches(entry, WRAPS_SDK)).toEqual([]);
    },
  );

  it.each(["wraps.js", "wraps.cjs"])(
    "%s loads @wraps.dev/email only inside import()",
    (entry) => {
      expect(reaches(entry, WRAPS_SDK, "static")).toEqual([]);
      expect(reaches(entry, WRAPS_SDK, "dynamic")).toEqual([
        expect.stringMatching(/^dynamic @wraps\.dev\/email in /),
      ]);
    },
  );
});

describe("the channel entries stay free of the plugin's runtime", () => {
  // src/permanent.ts is import-free so these entries don't pull in the event
  // code, and with it @better-auth/core/context
  it.each(["wraps.js", "wraps.cjs", "mailer.js", "mailer.cjs"])(
    "%s reaches no better-auth",
    (entry) => {
      expect(reaches(entry, BETTER_AUTH)).toEqual([]);
    },
  );
});

describe("web push uses WebCrypto only", () => {
  const NODE_CRYPTO = ["node:crypto", "crypto", "web-push"] as const;
  it.each([
    "index.js",
    "index.cjs",
    "client.js",
    "client.cjs",
    "testing.js",
  ])("%s reaches no node:crypto and no web-push package", (entry) => {
    expect(reaches(entry, NODE_CRYPTO)).toEqual([]);
  });

  it.each(["index.js", "index.cjs", "client.js", "client.cjs"])(
    "%s never touches the browser's navigator",
    (entry) => {
      for (const file of new Set(reachable(entry).map((ref) => ref.file))) {
        expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(
          /\bnavigator\b/,
        );
      }
    },
  );

  it("the built root exports generateVapidKeys and the host list, in ESM and CJS", async () => {
    const esm = await import(pathToFile("index.js"));
    const cjs = createRequire(import.meta.url)(join(dist, "index.cjs"));
    for (const mod of [esm, cjs]) {
      expect(typeof mod.generateVapidKeys).toBe("function");
      expect(mod.DEFAULT_PUSH_HOSTS).toContain("fcm.googleapis.com");
    }
    const keys = await esm.generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[\w-]{87}$/);
  });

  it("the built ./testing entry exports the fake transport and subscription", async () => {
    const mod = await import(pathToFile("testing.js"));
    expect(typeof mod.fakePushTransport).toBe("function");
    expect(typeof mod.fakePushSubscription).toBe("function");
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    main?: string;
    module?: string;
    types?: string;
    exports: Record<string, Record<string, string>>;
  };

  it("lists every entry point", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [".", "./client", "./mailer", "./react", "./testing", "./wraps"].sort(),
    );
  });

  it("has every path in `exports` (and main, module, types) in dist/", () => {
    const wanted = [
      ...Object.values(pkg.exports).flatMap((entry) => Object.values(entry)),
      pkg.main,
      pkg.module,
      pkg.types,
    ].filter((p): p is string => typeof p === "string");
    const missing = wanted.filter((p) => !existsSync(resolve(root, p)));
    expect(missing).toEqual([]);
  });
});

describe("the built ./mailer entry", () => {
  it("loads in ESM and CJS and exports mailerChannel", async () => {
    const esm = await import(pathToFile("mailer.js"));
    const cjs = createRequire(import.meta.url)(join(dist, "mailer.cjs"));
    expect(typeof esm.mailerChannel).toBe("function");
    expect(typeof cjs.mailerChannel).toBe("function");
    // the helpers a custom `render` uses, so the link logic needn't come from /wraps
    expect(typeof esm.renderEmail).toBe("function");
    expect(typeof esm.notificationUrl).toBe("function");
  });
});

function pathToFile(name: string) {
  return join(dist, name);
}
