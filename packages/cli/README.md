Leapp CLI
=================

Leapp's Command Line Interface.

It relies on Leapp Core, which encapsulates the domain logic.

For more information about the project visit the [site](www.leapp.cloud).

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/@noovolari/leapp-core.svg)](https://npmjs.org/package/@noovolari/leapp-cli)
[![Downloads/week](https://img.shields.io/npm/dw/@noovolari/leapp-core.svg)](https://npmjs.org/package/@noovolari/leapp-cli)
[![License](https://img.shields.io/npm/l/@noovolari/leapp-core.svg)](https://github.com/Noovolari/leapp/package.json)
<!--[![CircleCI](https://circleci.com/gh/oclif/hello-world/tree/main.svg?style=shield)](https://circleci.com/gh/oclif/hello-world/tree/main)-->

<!-- toc -->
* [Usage](#usage)
* [AWS CLI Login sessions](#aws-cli-login-sessions)
* [Commands](#commands)
* [Command Topics](#command-topics)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g @noovolari/leapp-cli
$ leapp COMMAND
running command...
$ leapp (--version)
@noovolari/leapp-cli/0.1.65 darwin-arm64 node-v24.2.0
$ leapp --help [COMMAND]
USAGE
  $ leapp COMMAND
...
```
<!-- usagestop -->
# AWS CLI Login sessions

On macOS, install AWS CLI **2.32.0 or later** and keep Leapp Desktop running.
This session type uses `aws login`, not IAM Identity Center's `aws sso login`.
Use an existing AWS CLI login profile or provide a new source profile name;
Start opens Terminal and the browser when interactive authentication is needed.
The login identity must already have the AWS permissions needed for your work;
Leapp does not assume another role or add IAM permissions.

```sh
leapp profile list
leapp session add --providerType aws --sessionType awsCliLogin \
  --sessionName "AWS login" --region eu-west-1 \
  --sourceProfile login-source --profileId DESTINATION_PROFILE_ID
leapp session start "AWS login"
leapp session list -x
leapp session current --profile leapp-destination --provider aws
leapp session stop "AWS login"
```

`--sourceProfile` is the AWS CLI profile **name**, while `--profileId` is the
Leapp-managed destination profile **ID** from `leapp profile list`. Omitting
`--profileId` uses Leapp's default destination. Source and destination must differ,
and each source may belong to only one Leapp session. Leapp respects AWS
configuration/cache location overrides and never copies AWS refresh tokens.

Start reuses valid login credentials and authenticates only when required.
Leapp Desktop owns refresh while the session is active; reauthentication may open
Terminal again. `session generate SESSIONID` retains credential-process mode and
writes only its JSON credential result to stdout.

AWS CLI Login sessions cannot be role-chain parents or use SSM. Console access
currently reports an explicit unavailable error: IAM-user console access is
unsupported, and federated-role console access has not been verified. There is
no generic console URL fallback or additional role assumption.

Stop removes Leapp's destination credentials and logs out the source profile.
This can affect other tools sharing that login; logout does not guarantee
revocation of already issued credentials or browser sessions.

# Commands
<!-- commands -->
# Command Topics

* [`leapp help`](scopes/help.md) - Display help for leapp.
* [`leapp idp-url`](scopes/idp-url.md) - SAML 2.0 Identity providers URL management
* [`leapp integration`](scopes/integration.md) - Leapp Integrations management
* [`leapp profile`](scopes/profile.md) - Leapp AWS Multi-profile management
* [`leapp region`](scopes/region.md) - Leapp regions management
* [`leapp session`](scopes/session.md) - Sessions management
* [`leapp set-workspace`](scopes/set-workspace.md) - Set the current Leapp workspace
* [`leapp team`](scopes/team.md) - Login to your Team account
* [`leapp version`](scopes/version.md) - Displays the Cli and Core versions
* [`leapp workspace`](scopes/workspace.md) - Show the current workspace

<!-- commandsstop -->
