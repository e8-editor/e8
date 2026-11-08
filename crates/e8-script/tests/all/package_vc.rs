//! Packages from git repositories (packages/package-vc.ts and
//! use-package.ts, ADR 0059), installed from repositories made here so no
//! test needs the network.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// A package repository with a commit and tag per version, each setting
/// NAME-version to the version when loaded.
fn repository(root: &Path, repo: &str, name: &str, versions: &[&str], manifest: impl Fn(&str) -> String) -> PathBuf {
    let dir = root.join(repo);
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "--quiet"]);
    for version in versions {
        tag(&dir, name, version, &manifest(version));
    }
    dir
}

fn tag(dir: &Path, name: &str, version: &str, manifest: &str) {
    fs::write(dir.join("e8-package.json"), manifest).unwrap();
    fs::write(dir.join(format!("{name}.ts")), format!("e8.setVariable(\"{name}-version\", \"{version}\");\n")).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "--quiet", "-m", version]);
    git(dir, &["tag", &format!("v{version}")]);
}

fn simple(name: &str) -> impl Fn(&str) -> String {
    let name = name.to_string();
    move |_| format!("{{ \"name\": \"{name}\" }}")
}

/// An editor whose configuration directory is `config`.
fn editor(config: &Path) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("user-emacs-directory", Value::Str(format!("{}/", config.display())));
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, js: &str) -> e8_core::Result<String> {
    s.eval_expression(ed, js)
}

fn lock(config: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(config.join("e8-lock.json")).unwrap()).unwrap()
}

/// Waits for an upgrade's fetching in the background to end, as its
/// result replaces the "Fetching" message.
fn upgraded(ed: &mut Editor) -> String {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while ed.echo().is_none_or(|e| e.starts_with("Fetching")) && std::time::Instant::now() < until {
        ed.accept_process_output(std::time::Duration::from_millis(20));
    }
    ed.echo().unwrap_or_default().to_string()
}

fn use_package(name: &str, url: &Path, rev: Option<&str>) -> String {
    let rev = rev.map(|r| format!(", rev: \"{r}\"")).unwrap_or_default();
    format!("e8.usePackage(\"{name}\", {{ url: {:?}{rev} }})", url.display().to_string())
}

#[test]
fn use_package_installs_the_newest_tag_activates_and_requires_it() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0", "0.10.0", "0.2.0"], simple("alpha"));
    let (mut ed, s) = editor(&config);
    assert_eq!(eval(&mut ed, &s, &use_package("alpha", &alpha, None)).unwrap(), "\"alpha\"");
    // Versions compare as numbers: 0.10.0 is newer than 0.2.0.
    assert_eq!(ed.variable("alpha-version"), Some(Value::Str("0.10.0".into())));
    assert!(config.join("repos/alpha/alpha.ts").is_file());
    let Some(Value::List(path)) = ed.variable("load-path") else { panic!() };
    assert_eq!(path[0], Value::Str(format!("{}/repos/alpha", config.display())));
    let lock = lock(&config);
    let entry = &lock["packages"]["alpha"];
    assert_eq!(entry["tag"], "v0.10.0");
    assert_eq!(entry["url"], alpha.display().to_string());
    assert_eq!(entry["commit"], git(&alpha, &["rev-parse", "v0.10.0"]));
    // Nothing is left of the clone but the package.
    let left: Vec<_> = fs::read_dir(config.join("repos")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left, vec!["alpha"]);
}

#[test]
fn the_lock_file_reproduces_the_commit_until_an_upgrade() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    {
        let (mut ed, s) = editor(&config);
        eval(&mut ed, &s, &use_package("alpha", &alpha, None)).unwrap();
    }
    // A newer version appears upstream, and another machine has only init.ts and the lock file.
    tag(&alpha, "alpha", "0.2.0", "{ \"name\": \"alpha\" }");
    fs::remove_dir_all(config.join("repos")).unwrap();
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("alpha", &alpha, None)).unwrap();
    assert_eq!(ed.variable("alpha-version"), Some(Value::Str("0.1.0".into())));

    ed.call("package-vc-upgrade", vec![Arg::Str("alpha".into())]).unwrap();
    // Fetched in the background: the command returns at once, saying so.
    assert!(ed.echo().is_some_and(|e| e.starts_with("Fetching 1 package")), "{:?}", ed.echo());
    let echo = upgraded(&mut ed);
    assert!(echo.contains("alpha: v0.1.0 -> v0.2.0 (1 commit)"), "{echo}");
    assert_eq!(lock(&config)["packages"]["alpha"]["tag"], "v0.2.0");
    ed.call("package-vc-upgrade", vec![Arg::Str("alpha".into())]).unwrap();
    assert_eq!(upgraded(&mut ed), "alpha is up to date");
}

/// On a machine with the lock file but not the packages, the first package
/// asked for clones every package the lock file names, all at once, rather
/// than one clone after another as init.ts reaches each; each is then at
/// its locked commit. A repository that is gone is left for its own
/// usePackage to report.
#[test]
fn the_packages_the_lock_file_names_are_cloned_at_once() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let names = ["alpha", "beta", "gamma", "delta"];
    let repos: Vec<PathBuf> = names.iter().map(|n| repository(root.path(), &format!("e8-{n}"), n, &["0.1.0"], simple(n))).collect();
    {
        let (mut ed, s) = editor(&config);
        for (name, repo) in names.iter().zip(&repos) {
            eval(&mut ed, &s, &use_package(name, repo, None)).unwrap();
        }
    }
    // Upstream moves on, delta's repository goes, and another machine has only init.ts and the lock file.
    for (name, repo) in names.iter().zip(&repos) {
        tag(repo, name, "0.2.0", &format!("{{ \"name\": \"{name}\" }}"));
    }
    fs::remove_dir_all(&repos[3]).unwrap();
    fs::remove_dir_all(config.join("repos")).unwrap();
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("alpha", &repos[0], None)).unwrap();
    for name in ["alpha", "beta", "gamma"] {
        assert!(config.join(format!("repos/{name}/{name}.ts")).is_file(), "{name} is cloned with the first");
    }
    assert!(!config.join("repos/delta").exists());
    let log = ed.messages().join("\n");
    assert!(log.contains("Installing 4 packages from e8-lock.json... 4/4"), "{log}");
    for (name, repo) in names.iter().zip(&repos).skip(1).take(2) {
        eval(&mut ed, &s, &use_package(name, repo, None)).unwrap();
    }
    for name in ["alpha", "beta", "gamma"] {
        assert_eq!(ed.variable(&format!("{name}-version")), Some(Value::Str("0.1.0".into())), "{name} is at its locked commit");
    }
    // No clone was left half made.
    let left: Vec<_> = fs::read_dir(config.join("repos")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(left.iter().all(|f| !f.starts_with(".installing")), "{left:?}");
    let missing = eval(&mut ed, &s, &use_package("delta", &repos[3], None)).unwrap_err().to_string();
    assert!(missing.contains("git clone") && missing.contains("failed"), "{missing}");
}

#[test]
fn starting_with_packages_installed_runs_no_git() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    {
        let (mut ed, s) = editor(&config);
        eval(&mut ed, &s, &use_package("alpha", &alpha, None)).unwrap();
    }
    let (mut ed, s) = editor(&config);
    ed.set_variable("vc-git-program", Value::Str("/no/such/git".into()));
    eval(&mut ed, &s, &use_package("alpha", &alpha, None)).unwrap();
    assert_eq!(ed.variable("alpha-version"), Some(Value::Str("0.1.0".into())));
}

#[test]
fn a_rev_pins_a_tag_and_a_branch_is_followed() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0", "0.2.0"], simple("alpha"));
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("alpha", &alpha, Some("v0.1.0"))).unwrap();
    assert_eq!(ed.variable("alpha-version"), Some(Value::Str("0.1.0".into())));
    ed.call("package-vc-upgrade", vec![Arg::Str("alpha".into())]).unwrap();
    assert_eq!(upgraded(&mut ed), "alpha is pinned to v0.1.0");

    // The configuration now follows main: the checkout moves to it.
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("alpha", &alpha, Some("main"))).unwrap();
    let entry = lock(&config)["packages"]["alpha"].clone();
    assert_eq!(entry["branch"], "main");
    assert_eq!(entry["rev"], "main");
    fs::write(alpha.join("alpha.ts"), "e8.setVariable(\"alpha-version\", \"head\");\n").unwrap();
    git(&alpha, &["commit", "--quiet", "-am", "head"]);
    ed.call("package-vc-upgrade", vec![Arg::Str("alpha".into())]).unwrap();
    upgraded(&mut ed);
    assert_eq!(lock(&config)["packages"]["alpha"]["commit"], git(&alpha, &["rev-parse", "main"]));
}

#[test]
fn requirements_are_installed_and_their_versions_checked() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    let alpha_path = alpha.display().to_string();
    let beta = repository(root.path(), "e8-beta", "beta", &["1.0.0"], |_| {
        format!("{{ \"name\": \"beta\", \"requires\": {{ \"alpha\": \"{alpha_path}@0.1.0\" }} }}")
    });
    fs::write(beta.join("beta.ts"), "import \"alpha\";\ne8.setVariable(\"beta-version\", \"1.0.0\");\n").unwrap();
    git(&beta, &["commit", "--quiet", "-am", "import alpha"]);
    git(&beta, &["tag", "-f", "v1.0.0"]);
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("beta", &beta, None)).unwrap();
    assert_eq!(ed.variable("alpha-version"), Some(Value::Str("0.1.0".into())));
    assert_eq!(ed.variable("beta-version"), Some(Value::Str("1.0.0".into())));
    assert_eq!(lock(&config)["packages"]["alpha"]["tag"], "v0.1.0");

    // alpha is needed by beta, so it stays; beta can go, and then alpha.
    let e = ed.call("package-delete", vec![Arg::Str("alpha".into())]).unwrap_err();
    assert!(e.to_string().contains("Package alpha is a dependency of beta"), "{e}");
    ed.call("package-delete", vec![Arg::Str("beta".into())]).unwrap();
    ed.call("package-delete", vec![Arg::Str("alpha".into())]).unwrap();
    assert!(!config.join("repos/alpha").exists());
    assert_eq!(lock(&config)["packages"], serde_json::json!({}));

    // A requirement newer than the version installed is refused.
    let gamma = repository(root.path(), "e8-gamma", "gamma", &["1.0.0"], |_| {
        format!("{{ \"name\": \"gamma\", \"requires\": {{ \"alpha\": \"{alpha_path}@0.5.0\" }} }}")
    });
    let e = eval(&mut ed, &s, &use_package("gamma", &gamma, None)).unwrap_err();
    assert!(e.to_string().contains("gamma needs alpha 0.5.0 or newer; 0.1.0 is installed"), "{e}");
}

#[test]
fn a_package_for_a_newer_e8_is_refused_before_it_runs() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let future = repository(root.path(), "e8-future", "future", &["1.0.0"], |_| "{ \"name\": \"future\", \"e8\": \"99.0.0\" }".into());
    let (mut ed, s) = editor(&config);
    let e = eval(&mut ed, &s, &use_package("future", &future, None)).unwrap_err();
    assert!(e.to_string().contains("future needs E8 99.0.0 or newer; this is 0."), "{e}");
    assert_eq!(ed.variable("future-version"), None);
    assert!(!config.join("repos/future").exists());
    let left = fs::read_dir(config.join("repos")).unwrap().count();
    assert_eq!(left, 0);
}

#[test]
fn a_repository_must_hold_the_package_named() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    let (mut ed, s) = editor(&config);
    let e = eval(&mut ed, &s, &use_package("beta", &alpha, None)).unwrap_err();
    assert!(e.to_string().contains("holds the package alpha, not beta"), "{e}");
}

#[test]
fn package_vc_install_installs_from_a_url() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    let (mut ed, _s) = editor(&config);
    ed.call("package-vc-install", vec![Arg::Str(alpha.display().to_string()), Arg::Prefix(None)]).unwrap();
    assert_eq!(ed.echo(), Some("Installed alpha v0.1.0"));
    assert!(config.join("repos/alpha/alpha.ts").is_file());
}

#[test]
fn sources_and_versions_read_as_the_adr_says() {
    let dir = tempfile::tempdir().unwrap();
    let (mut ed, s) = editor(dir.path());
    let file = dir.path().join("check.ts");
    fs::write(
        &file,
        r#"import { compareVersions, parseRequirement, parseVersion, repositoryName, sourceUrl } from "package-vc";
e8.setVariable("checked", JSON.stringify([
  sourceUrl("e8-editor/e8-org-roam"),
  repositoryName("https://github.com/e8-editor/e8-org-roam.git"),
  parseRequirement("e8-editor/e8-magit-section@0.1.0"),
  parseRequirement("git@github.com:a/b.git"),
  parseVersion("v1.2.3"),
  parseVersion("nightly"),
  compareVersions([0, 10], [0, 2, 9]) > 0,
]));
"#,
    )
    .unwrap();
    s.load_module(&mut ed, &file).unwrap();
    let Some(Value::Str(checked)) = ed.variable("checked") else { panic!() };
    assert_eq!(
        checked,
        r#"["https://github.com/e8-editor/e8-org-roam.git","e8-org-roam",{"source":"e8-editor/e8-magit-section","version":[0,1,0]},{"source":"git@github.com:a/b.git"},[1,2,3],null,true]"#
    );
}

#[test]
fn a_manifest_cannot_pass_git_an_option_or_name_a_path() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let sneaky = repository(root.path(), "e8-sneaky", "sneaky", &["1.0.0"], |_| {
        "{ \"name\": \"sneaky\", \"requires\": { \"evil\": \"--upload-pack=false\" } }".into()
    });
    let dots = repository(root.path(), "e8-dots", "dots", &["1.0.0"], |_| "{ \"name\": \"..\" }".into());
    let (mut ed, s) = editor(&config);
    let e = eval(&mut ed, &s, &use_package("sneaky", &sneaky, None)).unwrap_err();
    assert!(e.to_string().contains("Not a usable source: --upload-pack"), "{e}");
    let e = eval(&mut ed, &s, &use_package("..", &dots, None)).unwrap_err();
    assert!(e.to_string().contains("has no usable \"name\""), "{e}");
    let e = eval(&mut ed, &s, &use_package("sneaky", &sneaky, Some("--orphan=x"))).unwrap_err();
    assert!(e.to_string().contains("Not a usable revision"), "{e}");
}

/// A package whose new version needs a newer version of what it requires
/// upgrades that too, as Emacs's package manager does; upgrading all the
/// packages fetches them at once and upgrades a requirement first.
#[test]
fn upgrading_upgrades_a_requirement_that_is_too_old() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let alpha = repository(root.path(), "e8-alpha", "alpha", &["0.1.0"], simple("alpha"));
    let alpha_path = alpha.display().to_string();
    let requiring = |version: &str| format!("{{ \"name\": \"beta\", \"requires\": {{ \"alpha\": \"{alpha_path}@{version}\" }} }}");
    let beta = repository(root.path(), "e8-beta", "beta", &["1.0.0"], |_| requiring("0.1.0"));
    let (mut ed, s) = editor(&config);
    eval(&mut ed, &s, &use_package("beta", &beta, None)).unwrap();
    assert_eq!(lock(&config)["packages"]["alpha"]["tag"], "v0.1.0");

    // beta 2.0.0 needs alpha 0.2.0, which is out too.
    tag(&alpha, "alpha", "0.2.0", "{ \"name\": \"alpha\" }");
    tag(&beta, "beta", "2.0.0", &requiring("0.2.0"));
    ed.call("package-vc-upgrade", vec![Arg::Str("beta".into())]).unwrap();
    let echo = upgraded(&mut ed);
    assert!(echo.contains("beta: v1.0.0 -> v2.0.0"), "{echo}");
    assert_eq!(lock(&config)["packages"]["alpha"]["tag"], "v0.2.0");
    assert_eq!(lock(&config)["packages"]["beta"]["tag"], "v2.0.0");

    // Again with both newer: alpha, which beta requires, comes first, though
    // "alpha" sorts before "beta" either way; each says what it did.
    tag(&alpha, "alpha", "0.3.0", "{ \"name\": \"alpha\" }");
    tag(&beta, "beta", "3.0.0", &requiring("0.3.0"));
    ed.call("package-vc-upgrade-all", vec![]).unwrap();
    assert!(ed.echo().is_some_and(|e| e.starts_with("Fetching 2 packages")), "{:?}", ed.echo());
    let echo = upgraded(&mut ed);
    assert!(echo.contains("alpha: v0.2.0 -> v0.3.0") && echo.contains("beta: v2.0.0 -> v3.0.0"), "{echo}");
}
