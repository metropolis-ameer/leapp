import { Component, Input, OnInit } from "@angular/core";
import { Session } from "@noovolari/leapp-core/models/session";
import { AppService } from "../../../services/app.service";
import { FormControl, FormGroup, Validators } from "@angular/forms";
import { AppProviderService } from "../../../services/app-provider.service";
import { MessageToasterService, ToastLevel } from "../../../services/message-toaster.service";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import * as uuid from "uuid";
import { AwsCliLoginSession } from "@noovolari/leapp-core/models/aws/aws-cli-login-session";

@Component({
  selector: "app-change-named-profile-dialog",
  templateUrl: "./change-named-profile-dialog.component.html",
  styleUrls: ["./change-named-profile-dialog.component.scss"],
})
export class ChangeNamedProfileDialogComponent implements OnInit {
  @Input()
  public session: Session;
  public form = new FormGroup({
    awsProfile: new FormControl("", [Validators.required]),
  });
  public selectedProfile: any;
  public profiles: { value: string; label: string }[];
  public submitting = false;

  constructor(private appService: AppService, private appProviderService: AppProviderService, private messageToasterService: MessageToasterService) {}

  ngOnInit(): void {
    this.profiles = this.appProviderService.namedProfileService.getNamedProfiles().map((p) => ({ label: p.name, value: p.id }));
    this.selectedProfile = this.session.type !== SessionType.azure ? (this.session as any).profileId : undefined;
  }

  closeModal(): void {
    this.appService.closeModal();
  }

  addNewUUID(): string {
    return uuid.v4();
  }

  async changeProfile(): Promise<void> {
    if (this.submitting) {
      return;
    }
    if (this.selectedProfile) {
      if (this.session.type === SessionType.awsCliLogin) {
        this.submitting = true;
        try {
          const session = this.session as AwsCliLoginSession;
          const profile = this.selectedProfile;
          if (!profile.label?.trim()) {
            throw new Error("Select a destination named profile.");
          }
          if (profile.label.trim() === session.sourceProfile) {
            throw new Error("Source and destination profiles must be different.");
          }
          try {
            this.appProviderService.namedProfileService.getProfileName(profile.value);
          } catch (error) {
            profile.value = this.appProviderService.namedProfileService.createNamedProfile(profile.label).id;
          }
          await this.appProviderService.awsCliLoginService.update(session.sessionId, {
            sessionName: session.sessionName,
            sourceProfile: session.sourceProfile,
            region: session.region,
            profileId: profile.value,
          });
          this.messageToasterService.toast("Profile has been changed!", ToastLevel.success, "Profile changed!");
          this.closeModal();
        } catch (error) {
          this.messageToasterService.toast(error.message, ToastLevel.error);
        } finally {
          this.submitting = false;
        }
        return;
      }
      try {
        this.appProviderService.namedProfileService.getProfileName(this.selectedProfile.value);
      } catch (e) {
        this.selectedProfile.value = this.appProviderService.namedProfileService.createNamedProfile(this.selectedProfile.label).id;
      }

      this.appProviderService.namedProfileService.changeNamedProfile(this.session, this.selectedProfile.value);

      this.messageToasterService.toast("Profile has been changed!", ToastLevel.success, "Profile changed!");
      this.closeModal();
    }
  }
}
