/**
 * One shared matcher for every user-facing ignore list:
 * `cursorSettingSync.ignoredSettings`, `ignoredExtensions`, `ignoredUserFiles`
 * and `ignoredUiStateKeys`, plus the built-in machine-specific setting
 * defaults.
 *
 * An entry with no wildcard keeps matching exactly the way it always did, so
 * every configuration written before wildcards existed behaves identically.
 * On top of that:
 *
 * - `*` matches any run of characters. In a path-shaped list (`separator: "/"`)
 *   it stops at a separator, so `rules/*.md` is one directory deep; in a dotted
 *   list it does not, so `remote.SSH.*` covers `remote.SSH.configFile` and
 *   `remote.SSH.serverInstallPath.host` alike.
 * - `**` always matches across separators, and a doubled star standing alone
 *   between two separators also matches zero directories, so `rules/(**)/*.md`
 *   covers both `rules/a.md` and `rules/team/a.md`.
 * - In a path-shaped list an entry with no wildcard also matches everything
 *   below it, so `rules` and `rules/` both ignore the whole directory. That is
 *   what a trailing slash always looked like it did.
 *
 * Matching is pure: nothing here reads the filesystem or the configuration.
 */
export interface IgnorePatternOptions {
  /**
   * Path separator for a path-shaped list. When set, a bare `*` stops at the
   * separator and a wildcard-free entry also matches its children.
   */
  separator?: string;
  /** Lowercase both entries and candidates before matching. */
  caseFold?: boolean;
}

export interface IgnoreMatcher {
  /** The normalized entries, in configuration order, for diagnostics. */
  readonly patterns: readonly string[];
  matches(value: string): boolean;
  /**
   * The configured entries that matched none of `candidates`. A typo or an
   * unsupported pattern is otherwise completely silent: the user believes a
   * key or a file is excluded and it is not.
   */
  unmatched(candidates: Iterable<string>): string[];
}

interface CompiledPattern {
  pattern: string;
  test(value: string): boolean;
}

export const EMPTY_IGNORE_MATCHER: IgnoreMatcher = {
  patterns: [],
  matches: () => false,
  unmatched: () => [],
};

export function createIgnoreMatcher(
  entries: readonly string[],
  options: IgnorePatternOptions = {},
): IgnoreMatcher {
  const compiled: CompiledPattern[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "string") {
      continue;
    }
    const pattern = normalizeEntry(raw, options);
    if (pattern.length === 0 || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    compiled.push(compile(pattern, options));
  }
  return fromCompiled(compiled, options);
}

/**
 * Union of several matchers. Used where a per-profile list read out of
 * `settingsSync.ignoredSettings` has to be honored alongside the configured
 * one without rebuilding either.
 */
export function combineIgnoreMatchers(
  ...matchers: readonly IgnoreMatcher[]
): IgnoreMatcher {
  const present = matchers.filter((matcher) => matcher.patterns.length > 0);
  if (present.length === 0) {
    return EMPTY_IGNORE_MATCHER;
  }
  if (present.length === 1) {
    return present[0] as IgnoreMatcher;
  }
  return {
    patterns: present.flatMap((matcher) => [...matcher.patterns]),
    matches: (value) => present.some((matcher) => matcher.matches(value)),
    unmatched: (candidates) => {
      const observed = [...candidates];
      return present.flatMap((matcher) => matcher.unmatched(observed));
    },
  };
}

function fromCompiled(
  compiled: readonly CompiledPattern[],
  options: IgnorePatternOptions,
): IgnoreMatcher {
  if (compiled.length === 0) {
    return EMPTY_IGNORE_MATCHER;
  }
  const fold = options.caseFold === true;
  return {
    patterns: compiled.map((entry) => entry.pattern),
    matches(value: string): boolean {
      const candidate = fold ? foldCase(value) : value;
      return compiled.some((entry) => entry.test(candidate));
    },
    unmatched(candidates: Iterable<string>): string[] {
      const observed = [...candidates].map((value) =>
        fold ? foldCase(value) : value,
      );
      return compiled
        .filter((entry) => !observed.some((value) => entry.test(value)))
        .map((entry) => entry.pattern);
    },
  };
}

function compile(
  pattern: string,
  options: IgnorePatternOptions,
): CompiledPattern {
  if (!pattern.includes("*")) {
    if (options.separator === undefined) {
      return { pattern, test: (value) => value === pattern };
    }
    const prefix = pattern + options.separator;
    return {
      pattern,
      test: (value) => value === pattern || value.startsWith(prefix),
    };
  }
  const expression = compileGlob(pattern, options.separator);
  return { pattern, test: (value) => expression.test(value) };
}

function normalizeEntry(raw: string, options: IgnorePatternOptions): string {
  let entry = raw.trim();
  const separator = options.separator;
  if (separator !== undefined) {
    while (entry.endsWith(separator)) {
      entry = entry.slice(0, -separator.length);
    }
  }
  return options.caseFold === true ? foldCase(entry) : entry;
}

function foldCase(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function compileGlob(pattern: string, separator: string | undefined): RegExp {
  const anySegment =
    separator === undefined
      ? "[\\s\\S]*"
      : `[^${escapeCharacterClass(separator)}]*`;
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    if (
      separator !== undefined &&
      pattern.startsWith(`${separator}**${separator}`, index)
    ) {
      // `a/(**)/b` has to match `a/b` too, which a plain "anything" cannot do
      // because it would leave two separators behind.
      source += `${escapeRegExp(separator)}(?:[\\s\\S]*${escapeRegExp(separator)})?`;
      index += separator.length * 2 + 2;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      while (pattern[index] === "*") {
        index += 1;
      }
      source += "[\\s\\S]*";
      continue;
    }
    if (pattern[index] === "*") {
      source += anySegment;
      index += 1;
      continue;
    }
    source += escapeRegExp(pattern[index] as string);
    index += 1;
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCharacterClass(value: string): string {
  return value.replace(/[\\\]^-]/g, "\\$&");
}
