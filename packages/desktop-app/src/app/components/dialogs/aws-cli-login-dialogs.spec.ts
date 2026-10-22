import { CreateDialogComponent } from "./create-dialog/create-dialog.component";
import { EditDialogComponent } from "./edit-dialog/edit-dialog.component";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { SessionStatus } from "@noovolari/leapp-core/models/session-status";
import { OperatingSystem } from "@noovolari/leapp-core/models/operating-system";
import { ChangeNamedProfileDialogComponent } from "./change-named-profile-dialog/change-named-profile-dialog.component";
import { ChangeRegionDialogComponent } from "./change-region-dialog/change-region-dialog.component";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { NgSelectModule } from "@ng-select/ng-select";
import { BsModalService } from "ngx-bootstrap/modal";
import { of } from "rxjs";
import { AppService } from "../../services/app.service";
import { AppProviderService } from "../../services/app-provider.service";
import { OptionsService } from "../../services/options.service";
import { WindowService } from "../../services/window.service";
import { MessageToasterService } from "../../services/message-toaster.service";
import { LeappSelectComponent } from "../leapp-select/leapp-select.component";

describe("AWS CLI Login dialogs", () => {
  let provider: any;
  let app: any;
  let toast: any;
  let create: CreateDialogComponent;
  let edit: EditDialogComponent;

  const createDialog = (): CreateDialogComponent =>
    new CreateDialogComponent({} as any, app, { navigate: () => Promise.resolve(true) } as any, {} as any, {} as any, provider, {} as any, toast);

  const renderCreateDialog = async (sessionType: SessionType): Promise<ComponentFixture<CreateDialogComponent>> => {
    provider.workspaceService.getWorkspace = () => ({
      profiles: [
        { id: "destination-id", name: "default" },
        { id: "existing-destination-id", name: "existing-destination" },
      ],
      sessions: [],
      idpUrls: [],
    });
    provider.sessionManagementService.getAssumableSessions = () => [];
    provider.awsCoreService = { getRegions: () => [{ region: "eu-west-1" }] };
    provider.azureCoreService = { getLocations: () => [{ location: "westeurope" }] };
    await TestBed.configureTestingModule({
      declarations: [CreateDialogComponent, LeappSelectComponent],
      imports: [FormsModule, ReactiveFormsModule, NgSelectModule],
      providers: [
        { provide: OptionsService, useValue: {} },
        { provide: AppService, useValue: app },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
        { provide: BsModalService, useValue: {} },
        { provide: AppProviderService, useValue: provider },
        { provide: WindowService, useValue: {} },
        { provide: MessageToasterService, useValue: toast },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CreateDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.setProvider(sessionType);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    provider = {
      behaviouralSubjectService: {},
      sessionManagementService: { getSessions: () => [] },
      namedProfileService: {
        validateNewProfileName: () => "Profile already exists",
        getDefaultProfileId: () => "destination-id",
        getProfileName: () => "destination",
      },
      workspaceService: { getDefaultProfileId: () => "destination-id" },
      awsCliLoginService: {
        create: jasmine.createSpy("create").and.returnValue(Promise.resolve()),
        update: jasmine.createSpy("update").and.returnValue(Promise.resolve()),
      },
      teamService: {
        pushToRemote: jasmine.createSpy("pushToRemote").and.returnValue(Promise.resolve()),
        setSyncState: jasmine.createSpy("setSyncState"),
      },
      logService: { log: () => {} },
    };
    app = { closeModal: jasmine.createSpy("closeModal"), detectOs: () => OperatingSystem.mac };
    toast = { toast: jasmine.createSpy("toast") };
    create = createDialog();
    edit = new EditDialogComponent({} as any, {} as any, app, toast, {} as any, {} as any, provider, {} as any);
    create.sessionType = SessionType.awsCliLogin;
    edit.accountType = SessionType.awsCliLogin;
    edit.selectedSessionId = "session-id";
    edit.selectedSession = {
      sessionId: "session-id",
      sessionName: "Original",
      type: SessionType.awsCliLogin,
      sourceProfile: "source",
      profileId: "destination-id",
      region: "eu-west-1",
      status: SessionStatus.inactive,
    };
    [create, edit].forEach((component) => {
      component.form.patchValue({ name: " Alias ", sourceProfile: " source " });
      component.selectedRegion = "eu-west-1";
      component.selectedProfile = { value: "destination-id", label: "destination" };
    });
    create.selectedProfileEvent({ items: [create.selectedProfile], item: create.selectedProfile });
  });

  it("offers creation only on macOS", () => {
    expect(create.supportsCliLogin).toBeTrue();
    expect(create.accessStrategies.some((strategy) => strategy.value === SessionType.awsCliLogin)).toBeTrue();
    app.detectOs = () => OperatingSystem.windows;
    create = createDialog();
    expect(create.supportsCliLogin).toBeFalse();
    expect(create.accessStrategies.some((strategy) => strategy.value === SessionType.awsCliLogin)).toBeFalse();
  });

  it("selects an access method across mouse down and change detection", async () => {
    const fixture = await renderCreateDialog(SessionType.awsIamRoleFederated);
    const select: HTMLElement = fixture.nativeElement.querySelector('ng-select[formControlName="selectAccessStrategy"]');
    select.querySelector(".ng-select-container").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();
    const option = Array.from(select.querySelectorAll<HTMLElement>(".ng-option")).find((item) => item.textContent.includes("AWS CLI Login"));
    expect(option).toBeDefined();
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();
    option.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.sessionType).toBe(SessionType.awsCliLogin);
    expect(fixture.componentInstance.form.controls.selectAccessStrategy.value).toBe(SessionType.awsCliLogin);
    expect(fixture.nativeElement.querySelector('input[formControlName="sourceProfile"]')).not.toBeNull();
    fixture.destroy();
  });

  it("does not submit the hidden default when the visible destination is empty", async () => {
    const fixture = await renderCreateDialog(SessionType.awsCliLogin);
    fixture.componentInstance.form.patchValue({ name: "Alias", sourceProfile: "source" });
    fixture.detectChanges();
    const select: HTMLElement = fixture.nativeElement.querySelector("app-leapp-select ng-select");
    expect(select.querySelector(".ng-value")).toBeNull();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector("button.btn-right-margin");
    expect(button.disabled).toBeTrue();
    expect(fixture.componentInstance.cliLoginValidationError).toContain("destination");
    await fixture.componentInstance.saveSession();
    expect(provider.awsCliLoginService.create).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it("enables creation after entering visible fields and selecting a new destination tag", async () => {
    provider.namedProfileService.validateNewProfileName = () => true;
    provider.namedProfileService.createNamedProfile = jasmine.createSpy("createNamedProfile").and.returnValue({ id: "new-destination-id" });
    const fixture = await renderCreateDialog(SessionType.awsCliLogin);
    for (const [field, value] of [
      ["name", "Alias"],
      ["sourceProfile", "source"],
    ]) {
      const input: HTMLInputElement = fixture.nativeElement.querySelector(`input[formControlName="${field}"]`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const select: HTMLElement = fixture.nativeElement.querySelector("app-leapp-select ng-select");
    select.querySelector(".ng-select-container").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();
    const search = select.querySelector<HTMLInputElement>(".ng-input input");
    search.value = "new-destination";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    const tag = Array.from(select.querySelectorAll<HTMLElement>(".ng-option")).find((item) => item.textContent.includes("new-destination"));
    expect(tag).toBeDefined();
    tag.click();
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector("button.btn-right-margin");
    expect(button.disabled).toBeFalse();
    await fixture.componentInstance.saveSession();
    expect(provider.namedProfileService.createNamedProfile).toHaveBeenCalledWith("new-destination");
    expect(provider.awsCliLoginService.create).toHaveBeenCalledWith({
      sessionName: "Alias",
      sourceProfile: "source",
      region: fixture.componentInstance.selectedRegion,
      profileId: "new-destination-id",
    });
    fixture.destroy();
  });

  it("submits the visible existing destination instead of a stale default and requires a selection after clearing", async () => {
    const fixture = await renderCreateDialog(SessionType.awsCliLogin);
    fixture.componentInstance.form.patchValue({ name: "Alias", sourceProfile: "source" });
    const select: HTMLElement = fixture.nativeElement.querySelector("app-leapp-select ng-select");
    select.querySelector(".ng-select-container").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();
    const option = Array.from(select.querySelectorAll<HTMLElement>(".ng-option")).find((item) => item.textContent.includes("existing-destination"));
    expect(option).toBeDefined();
    option.click();
    fixture.detectChanges();
    fixture.componentInstance.selectedProfile = { value: "destination-id", label: "default" };
    await fixture.componentInstance.saveSession();
    expect(provider.awsCliLoginService.create).toHaveBeenCalledWith({
      sessionName: "Alias",
      sourceProfile: "source",
      region: fixture.componentInstance.selectedRegion,
      profileId: "existing-destination-id",
    });
    provider.awsCliLoginService.create.calls.reset();
    select.querySelector(".ng-clear-wrapper").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.cliLoginValidationError).toContain("destination");
    const button: HTMLButtonElement = fixture.nativeElement.querySelector("button.btn-right-margin");
    expect(button.disabled).toBeTrue();
    await fixture.componentInstance.saveSession();
    expect(provider.awsCliLoginService.create).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it("requires all four fields without requiring unrelated IAM fields", () => {
    expect(create.formValid()).toBeTrue();
    expect(edit.formValid()).toBeTrue();
    create.selectedRegion = undefined;
    edit.form.controls.sourceProfile.setValue(" ");
    expect(create.formValid()).toBeFalse();
    expect(edit.formValid()).toBeFalse();
  });

  it("creates using the new core request, without initiating login", async () => {
    await create.saveSession();
    expect(provider.awsCliLoginService.create).toHaveBeenCalledWith({
      sessionName: "Alias",
      sourceProfile: "source",
      region: "eu-west-1",
      profileId: "destination-id",
    });
    expect(app.closeModal).toHaveBeenCalled();
    expect(create.submitting).toBeFalse();
  });

  it("prevents duplicate source creation instead of silently cloning", async () => {
    provider.sessionManagementService.getSessions = () => [{ sessionId: "other", type: SessionType.awsCliLogin, sourceProfile: "source" }];
    await create.saveSession();
    expect(provider.awsCliLoginService.create).not.toHaveBeenCalled();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it("uses core update without mutating the selected session", async () => {
    await edit.saveAccount();
    expect(provider.awsCliLoginService.update).toHaveBeenCalledWith("session-id", {
      sessionName: "Alias",
      sourceProfile: "source",
      region: "eu-west-1",
      profileId: "destination-id",
    });
    expect(edit.selectedSession.sessionName).toBe("Original");
    expect(app.closeModal).toHaveBeenCalled();
  });

  it("creates a new destination tag before updating an edited session", async () => {
    edit.selectedProfile = { label: "new-destination", value: undefined };
    provider.namedProfileService.validateNewProfileName = () => true;
    provider.namedProfileService.createNamedProfile = jasmine.createSpy("createNamedProfile").and.returnValue({ id: "new-destination-id" });
    await edit.saveAccount();
    expect(provider.namedProfileService.createNamedProfile).toHaveBeenCalledWith("new-destination");
    expect(provider.awsCliLoginService.update).toHaveBeenCalledWith("session-id", {
      sessionName: "Alias",
      sourceProfile: "source",
      region: "eu-west-1",
      profileId: "new-destination-id",
    });
  });

  it("keeps the edit dialog open and clears submitting on a core error", async () => {
    provider.awsCliLoginService.update.and.returnValue(Promise.reject(new Error("Source profile is in use")));
    await edit.saveAccount();
    expect(app.closeModal).not.toHaveBeenCalled();
    expect(edit.submitting).toBeFalse();
    expect(toast.toast.calls.mostRecent().args[0]).toBe("Source profile is in use");
  });

  it("prevents another save while a request is pending", async () => {
    create.submitting = true;
    edit.submitting = true;
    await create.saveSession();
    await edit.saveAccount();
    expect(provider.awsCliLoginService.create).not.toHaveBeenCalled();
    expect(provider.awsCliLoginService.update).not.toHaveBeenCalled();
  });

  it("switches destination profiles through core update", async () => {
    const changeProfile = new ChangeNamedProfileDialogComponent(app, provider, toast);
    changeProfile.session = edit.selectedSession;
    changeProfile.selectedProfile = { value: "new-destination-id", label: "new-destination" };
    await changeProfile.changeProfile();
    expect(provider.awsCliLoginService.update).toHaveBeenCalledWith("session-id", {
      sessionName: "Original",
      sourceProfile: "source",
      region: "eu-west-1",
      profileId: "new-destination-id",
    });
  });

  it("creates a new destination tag before switching profiles", async () => {
    const changeProfile = new ChangeNamedProfileDialogComponent(app, provider, toast);
    changeProfile.session = edit.selectedSession;
    changeProfile.selectedProfile = { label: "new-destination" };
    provider.namedProfileService.getProfileName = () => {
      throw new Error("Profile does not exist yet");
    };
    provider.namedProfileService.createNamedProfile = jasmine.createSpy("createNamedProfile").and.returnValue({ id: "new-destination-id" });
    await changeProfile.changeProfile();
    expect(provider.namedProfileService.createNamedProfile).toHaveBeenCalledWith("new-destination");
    expect(provider.awsCliLoginService.update).toHaveBeenCalledWith("session-id", {
      sessionName: "Original",
      sourceProfile: "source",
      region: "eu-west-1",
      profileId: "new-destination-id",
    });
  });

  it("rejects a destination matching the source without updating", async () => {
    const changeProfile = new ChangeNamedProfileDialogComponent(app, provider, toast);
    changeProfile.session = edit.selectedSession;
    changeProfile.selectedProfile = { value: "source-id", label: "source" };
    await changeProfile.changeProfile();
    expect(provider.awsCliLoginService.update).not.toHaveBeenCalled();
    expect(app.closeModal).not.toHaveBeenCalled();
  });

  it("switches region through core update, including pending-session cancellation", async () => {
    edit.selectedSession.status = SessionStatus.pending;
    const changeRegion = new ChangeRegionDialogComponent(app, provider, toast);
    changeRegion.session = edit.selectedSession;
    changeRegion.selectedRegion = "us-west-2";
    await changeRegion.changeRegion();
    expect(provider.awsCliLoginService.update).toHaveBeenCalledWith("session-id", {
      sessionName: "Original",
      sourceProfile: "source",
      profileId: "destination-id",
      region: "us-west-2",
    });
  });
});
