---
title: "Configure AWS CLI Login"
description: "Use browser-based AWS CLI login as a Leapp session on macOS."
page_type: "session"
---

# Configure AWS CLI Login

AWS CLI Login sessions use `aws login --profile <source-profile>` to obtain
temporary credentials without entering long-term access keys into Leapp.
This is different from `aws sso login` and the AWS Single Sign-On integration.

## Requirements

- macOS with Terminal and a browser available.
- AWS CLI version **2.32.0 or later**, installed locally.
- An AWS commercial Region supported by `aws login` (not China or GovCloud).
- An IAM identity allowed to use AWS local-development sign-in. AWS documents
  the `SignInLocalDevelopmentAccess` policy for this purpose; ask your AWS
  administrator if sign-in is denied.

See the [AWS login guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)
for supported identities and permission requirements.

## Source and destination profiles

The **source profile** belongs to AWS CLI login. It stores login configuration,
and AWS manages its credential cache and refresh tokens.

The **named profile** selected in Leapp is the destination where Leapp publishes
temporary credentials. It must have a different name from the source profile.
Do not configure the source profile to obtain credentials through the
destination, because this creates a credential-resolution loop.

Only one Leapp session may use a particular source profile. As with other AWS
sessions, only one session may be active for a given destination named profile.

## Add a session

1. Add a session and select **Amazon AWS**.
2. Select **AWS CLI Login**.
3. Enter a session alias, source AWS profile, region, and destination named
   profile.
4. Create the session, then select **Start**.

You can enter an existing AWS login profile or a new source profile name.
Leapp passes the selected region explicitly to AWS CLI login and credential
export.
When login is necessary, complete the instructions in Terminal and your
browser. Leapp must verify credentials before showing the session as active.
An existing profile configured for another authentication method must not be
silently overwritten.

For CLI usage, select AWS CLI Login in `leapp session add`, or specify:

```bash
leapp session add --providerType aws --sessionType awsCliLogin \
  --sessionName "Development login" --sourceProfile development-login \
  --region us-east-1 --profileId <destination-profile-id>
```

Use the destination named profile with other tools:

```bash
aws sts get-caller-identity --profile <destination-profile-name>
```

## Refresh and Stop

Leapp reuses valid login credentials and refreshes its published credentials
before they expire. Keep Leapp desktop running for scheduled refresh of
credential-file sessions. The credential-process method obtains credentials
when a consuming tool requests them.

When the overall AWS login expires, interactive sign-in is required again.
Leapp may open Terminal and your browser automatically for an active session.
The account or role selected during a new login becomes the session's displayed
identity without another confirmation.

**Stop** removes the credentials Leapp published and runs
`aws logout --profile <source-profile>`. This can affect external tools or
other AWS profiles sharing that login cache. It does not guarantee revocation
of credentials already issued, and it does not sign out existing browser
console sessions. Leapp does not delete the source profile configuration.

## Console and other limitations

Authenticated AWS console access is **not supported for IAM-user AWS CLI login
credentials**. In the feasibility check, AWS returned a sign-in token but
rejected it when opening the console. Federated-role AWS CLI login console
access remains unverified and is not advertised as supported.

Console actions report an explicit unavailable error rather than opening a
generic sign-in page or potentially selecting the wrong account. No additional
console role is assumed and no IAM permissions are changed.

Role chaining and SSM connections from this session type are not supported.
