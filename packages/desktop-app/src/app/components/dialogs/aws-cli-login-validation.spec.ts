import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { Session } from "@noovolari/leapp-core/models/session";
import { awsCliLoginValidationError } from "./aws-cli-login-validation";

describe("AWS CLI Login desktop validation", () => {
  const destination = { value: "destination-id", label: "leapp-destination" };
  const existing = { sessionId: "existing", type: SessionType.awsCliLogin, sourceProfile: "source" } as unknown as Session;

  it("accepts existing and new source profile names without discovery", () => {
    expect(awsCliLoginValidationError("Alias", "existing-source", "eu-west-1", destination, [])).toBe("");
    expect(awsCliLoginValidationError("Alias", "new-source", "eu-west-1", destination, [])).toBe("");
  });

  it("requires alias, source, region and destination", () => {
    expect(awsCliLoginValidationError(" ", "source", "eu-west-1", destination, [])).not.toBe("");
    expect(awsCliLoginValidationError("Alias", " ", "eu-west-1", destination, [])).not.toBe("");
    expect(awsCliLoginValidationError("Alias", "source", "", destination, [])).not.toBe("");
    expect(awsCliLoginValidationError("Alias", "source", "eu-west-1", null, [])).not.toBe("");
  });

  it("accepts a new destination tag before a profile ID is assigned on save", () => {
    expect(awsCliLoginValidationError("Alias", "source", "eu-west-1", { label: "new-destination" }, [])).toBe("");
    expect(awsCliLoginValidationError("Alias", "source", "eu-west-1", { label: " " }, [])).toContain("destination");
  });

  it("rejects a source/destination collision after trimming", () => {
    expect(awsCliLoginValidationError("Alias", " leapp-destination ", "eu-west-1", destination, [])).toContain("must be different");
  });

  it("rejects duplicate sources, including a cloned session with a different ID", () => {
    expect(awsCliLoginValidationError("Clone", " source ", "eu-west-1", destination, [existing], "clone")).toContain("already assigned");
  });

  it("allows keeping the source on the same edited session", () => {
    expect(awsCliLoginValidationError("Edited", "source", "eu-west-1", destination, [existing], "existing")).toBe("");
  });
});
