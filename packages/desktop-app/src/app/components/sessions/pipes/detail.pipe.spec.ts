import { DetailPipe } from "./detail.pipe";
import { Session } from "@noovolari/leapp-core/models/session";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { AwsCliLoginSession } from "@noovolari/leapp-core/models/aws/aws-cli-login-session";

describe("DetailPipe", () => {
  const pipe = new DetailPipe();

  it("shows the CLI login source before identity has been resolved", () => {
    expect(pipe.transform(new AwsCliLoginSession("Alias", "us-east-1", "destination", "source"))).toBe("source");
  });

  it("shows resolved CLI login account and principal without assuming a role ARN", () => {
    const session = new AwsCliLoginSession("Alias", "us-east-1", "destination", "source");
    session.awsAccount = { accountId: "123456789012", accountName: "Example" };
    session.principalArn = "arn:aws:iam::123456789012:user/example";
    expect(pipe.transform(session)).toBe("source - 123456789012 - arn:aws:iam::123456789012:user/example");
  });

  it("preserves existing IAM user detail behavior", () => {
    expect(pipe.transform({ type: SessionType.awsIamUser } as Session)).toBe("");
  });
});
