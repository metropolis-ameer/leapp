# AWS CLI Login sessions

## Scope and agreed behavior

Add an AWS CLI Login session type to macOS desktop and Leapp CLI using
`aws login --profile <source-profile>`, not `aws sso login`.

- Link an existing AWS login profile or create a new one.
- Publish credentials to a separate Leapp-managed named profile.
- Reuse a valid login on Start; otherwise launch interactive login in Terminal
  and the browser.
- Refresh temporary credentials before expiration. Automatically launch login
  when interactive reauthentication is required while the session is active.
- Accept a newly selected account or role without another confirmation and
  update the displayed identity.
- On Stop, remove Leapp-published credentials and run
  `aws logout --profile <source-profile>`.
- Allow only one Leapp session per source profile. Preserve existing
  destination-profile switching.
- Open an authenticated AWS console for the selected identity.
- Exclude role chaining and SSM support.

## 1. Console feasibility gate

Establish whether AWS login-issued credentials support authenticated console
access through AWS federation, including applicable duration restrictions and
identity selection. Do not assume existing browser cookies select the correct
account.

If direct federation is unsupported or cannot be established, pause for a user
decision before implementation. Do not substitute a generic console URL or add
role assumptions and permission requirements without approval. Do not access
real local AWS credentials or initiate account login as part of research.

### Feasibility findings

With subsequent explicit user authorization, a local probe used the selected
source profile after the user completed `aws login`. The resolved principal
was an IAM user. The federation endpoint returned a sign-in token when no
duration parameter was supplied, but the isolated browser console rejected it.
The user reported: "Only can use federated login".

Therefore, obtaining a sign-in token is not sufficient evidence of console
support. Direct console access for the tested IAM-user login is not established
and must not be advertised as supported. Federated-role login has not been
tested. No account identifiers, credentials, or authenticated URLs are recorded
here.

The user subsequently approved implementing AWS login sessions with a clear
console-unavailable error for unsupported identities. IAM-user console access
must be rejected explicitly. Federated-role console access remains unverified;
do not advertise it as supported or silently open a generic sign-in page.
No additional role assumption or IAM changes are authorized.

## 2. Core session type

Add an `awsCliLogin` session type, model, creation request, and service. Persist
source profile name, destination profile ID, region, and resolved identity
metadata, but not AWS refresh tokens.

Register the service in session factories, cloud access methods, and desktop/CLI
providers. Cover persistence and reload, edit/delete, labels, and AWS filtering.
Reject duplicate source assignments and source/destination collisions. Exclude
the new type from role-assumer and SSM actions.

## 3. AWS CLI bridge

Use the installed AWS CLI and its supported commands:

```text
aws login --profile <source>
aws configure export-credentials --profile <source> --format process
aws logout --profile <source>
```

Require AWS CLI 2.32.0 or later and report installation/version/configuration
errors explicitly. Do not implement OAuth or parse AWS's private cache format.

Support macOS executable discovery, safe argument passing, interactive terminal
prompts, completion detection, cancellation, and actionable errors. The existing
buffered executor's 60-second timeout and terminal-launch completion are not
sufficient proof of successful authentication.

Do not log credentials, authorization codes, or authenticated console URLs.
Prevent inherited AWS credential variables from selecting an unintended
identity. Respect relevant AWS configuration/cache location overrides.

## 4. Lifecycle and refresh

Start validates configuration and exports credentials before deciding login is
needed. Distinguish authentication failures from network/configuration errors.
Only mark active after verified login, identity resolution, and publication.

Refresh before actual credential expiration, without changing existing session
timing. Coordinate desktop and CLI operations so a session has one login flow.
Do not open repeated terminal windows on timer ticks. Cancellation or Stop must
prevent a late login result from publishing credentials.

Preserve credential-file and credential-process modes. Credential-process
stdout must contain only its documented JSON result.

Stop removes only Leapp-owned destination entries and logs out the source.
Surface partial failures. Warn that external tools sharing the login can be
affected, and that logout does not guarantee revocation of issued credentials
or browser sessions.

## 5. Desktop and CLI integration

Add desktop create/edit controls for alias, source profile, region, and
destination profile. Display resolved identity and clear pending/error states.

Extend CLI session-add flags, validation, prompts, and examples. Dispatch
start/stop through the new core service. Integrate console actions with the
strategy established by the feasibility gate.

## 6. Acceptance and documentation

Cover existing/new profiles, valid-login reuse, interactive login/cancellation,
expiration-based refresh, reauthentication, identity changes, duplicate sources,
destination switching, logout failures, persistence, and preservation of
unrelated AWS configuration.

Verify credential-process output and ensure logs do not contain secrets.
Exercise targeted core, desktop, and CLI tests and available builds/type checks.

End-to-end acceptance: add a session, Start, complete login when required, use
the destination profile, open an authenticated console for that identity, then
Stop and verify destination cleanup and source logout. Real-account validation
requires explicit user participation; do not claim it was performed otherwise.

Document installation and IAM prerequisites, source versus destination
profiles, terminal behavior, refresh ownership, and logout limitations.

Delivery order: console feasibility, core lifecycle, desktop/CLI integration,
then acceptance and documentation.

## Implementation status

Core lifecycle, desktop and CLI integration, source/destination protections,
expiration-aware refresh, cancellation, owned-output cleanup, and explicit
console errors are implemented. User documentation is available at
`docs/configuring-session/configure-aws-cli-login.md`.

Validation used Node development containers through Podman, not a host Node
installation. Core tests, targeted CLI and headless-browser desktop tests,
TypeScript/template compilation, and changed-file lint passed. Validation-only
CLI mocks and an isolated desktop test entry were needed for existing test
harness compatibility; those workarounds do not change production code.

Native macOS core and desktop development builds also pass using a temporary
Node runtime and an isolated source copy. The app launches with its native
modules, and existing Leapp settings were backed up before launch. Initial
manual testing exposed an access-method dropdown regression: recreating the
options on every change-detection pass interrupted mouse selection. Options
are now stable for the dialog lifetime; a real DOM regression test reproduces
the original failure and passes with the fix. Dropdown selection and the
shortened form layout were then confirmed manually.

Native acceptance also exposed validation rejecting a newly selected
destination tag before its profile ID was assigned. Creation, editing, and
profile switching now accept the selected name and create its profile before
passing the ID to core. Missing-field messages identify the field requiring
attention. A real-widget creation regression reproduces the original failure.

An empty visible destination also retained an internal `default` selection.
AWS CLI Login validation and submission now use the actual destination form
control rather than that hidden fallback. Regression coverage follows the
real provider-selection lifecycle and verifies empty, selected, newly added,
and cleared destinations. All 30 targeted desktop specs pass in native
headless Chrome.

Native session creation has been confirmed manually. The first Start attempt
failed with Terminal and missing-region errors. Login and credential export
now receive the session region explicitly. The login child runs synchronously
in the foreground, and Terminal receives the command before activation to
avoid an activation-created empty window. A native pseudo-terminal regression
verifies terminal input, terminal settings, and interrupt handling without
contacting AWS; all 64 bridge/service specs pass on macOS.

Native creation, Start/sign-in, correct displayed identity, AWS CLI use of the
destination profile, and successful Stop have now been confirmed manually.
A post-Stop inspection found no remaining ownership-marked output sections
in either AWS config or shared credentials; no credential values were displayed.

Scheduled refresh, login-expiry reauthentication, and cancellation remain
covered by automated tests but have not been manually exercised end to end
in the native app. No installer was produced or installed.
