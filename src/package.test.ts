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

  it("is 0.11.2 on the better-auth 1.7.7 baseline", () => {
    expect(pkg.version).toBe("0.11.2");
    expect(pkg.peerDependencies?.["better-auth"]).toBe("^1.7.7");
    // emit imports @better-auth/core/context at runtime
    expect(pkg.peerDependencies?.["@better-auth/core"]).toBe("^1.7.7");
    expect(pkg.peerDependenciesMeta?.["@better-auth/core"]?.optional).not.toBe(
      true,
    );
    expect(pkg.dependencies?.["@byo-oss/core"]).toBe("^0.1.0");
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
