import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json")) as {
    version: string;
    dependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it("is 0.14.0 on the better-auth 1.7.16 baseline", () => {
    expect(pkg.version).toBe("0.14.0");
    expect(pkg.peerDependencies?.["better-auth"]).toBe("^1.7.16");
    // emit imports @better-auth/core/context at runtime
    expect(pkg.peerDependencies?.["@better-auth/core"]).toBe("^1.7.16");
    expect(pkg.peerDependenciesMeta?.["@better-auth/core"]?.optional).not.toBe(
      true,
    );
    expect(pkg.dependencies?.["@byo-oss/core"]).toBe("^0.2.0");
  });

  it("holds the security floors", () => {
    // zod: GHSA-mrhx-c7xc-m3w5; vitest: GHSA-5xrq-8626-4rwp
    expect(pkg.dependencies?.zod).toBe("^4.6.6");
    expect(pkg.peerDependencies?.vitest).toBe(">=3.2.6");
    expect(pkg.peerDependenciesMeta?.vitest?.optional).toBe(true);
  });

  it("ships the ./mailer entry and depends on @byo-oss/mailer 0.2+", () => {
    expect(pkg.dependencies?.["@byo-oss/mailer"]).toBe("^0.2.0");
    expect(pkg.exports?.["./mailer"]).toEqual({
      types: "./dist/mailer.d.ts",
      import: "./dist/mailer.js",
      require: "./dist/mailer.cjs",
    });
  });

  it.each(["README.md", "docs/upgrading.mdx"])(
    "%s has the 0.14 upgrade notes",
    (file) => {
      const text = read(file);
      expect(text).toContain("0.14");
      expect(text).toContain("GHSA-mrhx-c7xc-m3w5");
      expect(text).toContain("4.6.6");
    },
  );

  it.each(["README.md", "docs/upgrading.mdx"])(
    "%s has the 0.13 upgrade notes",
    (file) => {
      const text = read(file);
      expect(text).toContain("0.13");
      expect(text).toContain("1.7.16");
    },
  );

  it.each(["README.md", "docs/upgrading.mdx"])(
    "%s has the 0.11 upgrade notes",
    (file) => {
      expect(read(file)).toContain("mailerChannel");
      expect(read(file)).not.toContain("(unreleased)");
    },
  );

  it.each(["README.md", "docs/upgrading.mdx"])(
    "%s has the 0.10 upgrade notes",
    (file) => {
      const text = read(file);
      expect(text).toContain("0.10");
      expect(text).toContain("1.7.7");
    },
  );
});
