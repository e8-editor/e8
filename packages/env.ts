// Environment variables, after Emacs's env.el: setenv and getenv, which
// change and read process-environment, the environment every program E8
// starts is given, and substitute-env-vars.

e8.defineVariable({ name: "read-envvar-name-history", doc: "Environment variable names read so far, for M-p and M-n.", value: [] });
e8.defineVariable({ name: "setenv-history", doc: "Values given to setenv so far, for M-p and M-n.", value: [] });

const environment = (): string[] => {
  const env = e8.variable("process-environment");
  return Array.isArray(env) ? env.filter((e): e is string => typeof e === "string") : [];
};

/** The names process-environment gives values or unsets, for completing one. */
function environmentNames(): string[] {
  return environment().map((entry) => {
    const eq = entry.indexOf("=");
    return eq < 0 ? entry : entry.slice(0, eq);
  });
}

/**
 * Read an environment variable's name in the minibuffer, as
 * read-envvar-name, completing on those process-environment names;
 * `mustmatch` requires one of them.
 */
export function readEnvvarName(prompt: string, mustmatch?: boolean): string {
  return e8.completingRead(prompt, environmentNames(), { requireMatch: Boolean(mustmatch), history: "read-envvar-name-history" });
}

const SUBSTITUTE_VARS = /\$(?:([A-Za-z0-9_]+)|\{([^{}]+)\}|\$)/g;

/**
 * A string with each `$FOO` and `${FOO}` replaced by that environment
 * variable's value and `$$` by `$`, as substitute-env-vars. An undefined
 * variable becomes "" unless `whenUndefined` says otherwise: a function is
 * called with the name and gives the text, or undefined to leave the
 * reference as it is; anything else true leaves every such reference.
 */
export function substituteEnvVars(string: string, whenUndefined?: boolean | ((name: string) => string | undefined)): string {
  return string.replace(SUBSTITUTE_VARS, (whole, plain: string | undefined, braced: string | undefined) => {
    const name = plain ?? braced;
    if (name === undefined) return "$";
    const value = e8.getenv(name);
    if (value !== undefined) return value;
    if (typeof whenUndefined === "function") return whenUndefined(name) ?? whole;
    return whenUndefined ? whole : "";
  });
}

/** A file name with the environment variables it names substituted, leaving undefined ones, as substitute-env-in-file-name. */
export function substituteEnvInFileName(filename: string): string {
  return substituteEnvVars(filename, true);
}

/**
 * An environment list with `variable` set to `value`, as setenv-internal:
 * the entry for it changed in place, or added at the front; with no
 * value, its entry taken out, or, with `keepEmpty`, made the name alone,
 * which unsets it. Returns the new list.
 */
export function setenvInternal(env: e8.Value[], variable: string, value: string | undefined, keepEmpty: boolean): e8.Value[] {
  const matches = (entry: e8.Value) => typeof entry === "string" && (entry === variable || entry.startsWith(`${variable}=`));
  const i = env.findIndex((entry, n) => matches(entry) && env.slice(0, n).every((e) => typeof e === "string"));
  if (i >= 0) {
    const copy = [...env];
    if (value !== undefined) copy[i] = `${variable}=${value}`;
    else if (keepEmpty) copy[i] = variable;
    else copy.splice(i, 1);
    return copy;
  }
  if (value !== undefined || keepEmpty) return [value !== undefined ? `${variable}=${value}` : variable, ...env];
  return env;
}

/**
 * Set an environment variable for the programs E8 starts after this, as
 * setenv: in process-environment, so binding that around a call changes
 * only the programs it starts. With no value the variable is unset.
 * `substitute` replaces the environment variables `value` names. Setting
 * TZ changes E8's own time zone as well. Returns the new value.
 */
export function setenv(variable: string, value?: string | null, substitute?: boolean): string | undefined {
  let v = value ?? undefined;
  if (v !== undefined && substitute) v = substituteEnvVars(v);
  if (variable.includes("=")) e8.signal("error", `Environment variable name \`${variable}' contains \`='`);
  if (variable === "TZ") e8.setTimeZoneRule(v ?? null);
  const env = e8.variable("process-environment");
  e8.setVariable("process-environment", setenvInternal(Array.isArray(env) ? env : [], variable, v, true));
  return v;
}

/**
 * Run `body` with environment variables set, as Emacs's
 * with-environment-variables: each `[name, value]` set for the programs
 * it starts, process-environment restored afterwards.
 */
export function withEnvironmentVariables<T>(variables: [string, string][], body: () => T): T {
  const env = e8.variable("process-environment");
  return e8.letBind({ "process-environment": Array.isArray(env) ? [...env] : [] }, () => {
    for (const [name, value] of variables) setenv(name, value);
    return body();
  });
}

e8.defineCommand({
  name: "setenv",
  doc:
    "Set an environment variable for the programs E8 starts from now on.\n\n" +
    "Environment variables named in the value, as $HOME, are replaced by theirs. With a prefix argument, " +
    "unset the variable instead. This changes process-environment.",
  params: [
    {
      name: "variable",
      prompt: () => (e8.prefixArg() !== null ? "Clear environment variable: " : "Set environment variable: "),
      collection: () => environmentNames(),
      history: "read-envvar-name-history",
    },
    {
      name: "value",
      // The current value goes into the history, for M-p, as setenv's
      // interactive spec adds it.
      prompt: (variable: string) => {
        const current = e8.getenv(variable);
        if (current !== undefined) {
          const history = e8.variable("setenv-history");
          const rest = Array.isArray(history) ? history.filter((h) => h !== current) : [];
          e8.setVariable("setenv-history", [current, ...rest]);
        }
        return `Set ${variable} to value: `;
      },
      history: "setenv-history",
      value: () => (e8.prefixArg() !== null ? "" : undefined),
    },
    { name: "clear", kind: "prefix" },
  ],
  run: (variable: string, value: string, clear: e8.PrefixArg) => {
    setenv(variable, clear !== null ? undefined : value, true);
  },
});

e8.defineCommand({
  name: "getenv",
  doc: "Show an environment variable's value as programs E8 starts are given it, or \"Not set\".",
  params: [
    {
      name: "variable",
      prompt: "Get environment variable: ",
      collection: () => environmentNames(),
      requireMatch: true,
      history: "read-envvar-name-history",
    },
  ],
  run: (variable: string) => {
    e8.message(e8.getenv(variable) ?? "Not set");
  },
});
