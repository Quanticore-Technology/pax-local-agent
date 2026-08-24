; Inno Setup — GoNails PAX Agent (Windows installer)
;
; Compile on Windows: open in Inno Setup Compiler, or run iscc.exe pax-agent.iss
; Cross-compile from Mac/Linux: install Wine + Inno Setup; run via build.sh.
; CI: GitHub Actions on `windows-latest` works out of the box.
;
; Required preprocessor variables (set via /D on iscc command line, or hard-code):
;   AppVersion        — e.g. "0.2.1"
;   StagingDir        — absolute path containing pax-agent.exe + nssm.exe + scripts/

#ifndef AppVersion
  #define AppVersion "0.2.1"
#endif
#ifndef StagingDir
  #define StagingDir SourcePath + "build\staging"
#endif
#ifndef EnvLabel
  #define EnvLabel "dev"
#endif

[Setup]
AppId={{B5E5C2B0-9B5C-4F0D-B2DD-2E8C8C8C8C8C}
AppName=GoNails PAX Agent
AppVersion={#AppVersion}
AppPublisher=GoNails
AppPublisherURL=https://your-domain.com
AppSupportURL=https://your-domain.com/support
AppCopyright=© 2026 GoNails
DefaultDirName={autopf}\GoNails\PaxAgent
DefaultGroupName=GoNails PAX Agent
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
OutputDir={#SourcePath}dist
OutputBaseFilename=GoNailsPaxAgent-{#AppVersion}-{#EnvLabel}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
UninstallDisplayName=GoNails PAX Agent
UninstallDisplayIcon={app}\pax-agent.exe
CloseApplications=force

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut to the agent UI"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#StagingDir}\pax-agent.exe";              DestDir: "{app}";          Flags: ignoreversion
Source: "{#StagingDir}\nssm.exe";                   DestDir: "{app}";          Flags: ignoreversion
Source: "{#StagingDir}\scripts\install-service.bat"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StagingDir}\scripts\uninstall-service.bat"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StagingDir}\scripts\launch-ui.bat";      DestDir: "{app}\scripts";  Flags: ignoreversion
Source: "{#StagingDir}\README.txt";                 DestDir: "{app}";          Flags: ignoreversion isreadme

[Icons]
Name: "{group}\GoNails PAX Agent";        Filename: "{app}\scripts\launch-ui.bat"; WorkingDir: "{app}"; IconFilename: "{app}\pax-agent.exe"; Comment: "Open the PAX Agent configuration"
Name: "{group}\Uninstall PAX Agent";         Filename: "{uninstallexe}"
Name: "{commondesktop}\GoNails PAX Agent"; Filename: "{app}\scripts\launch-ui.bat"; WorkingDir: "{app}"; IconFilename: "{app}\pax-agent.exe"; Tasks: desktopicon

[Run]
; Register and start the Windows Service.
Filename: "{cmd}"; Parameters: "/C ""{app}\scripts\install-service.bat"""; \
  Flags: runhidden waituntilterminated; StatusMsg: "Registering background service..."

; Pop the config UI in the user's browser at the end of install — first-time
; setup happens via the in-page pairing code (no manual fields).
Filename: "{app}\scripts\launch-ui.bat"; Description: "Open agent UI"; \
  Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C ""{app}\scripts\uninstall-service.bat"""; \
  Flags: runhidden waituntilterminated

[UninstallDelete]
; Leave config + logs by default; the user can delete them manually if needed.
; Uncomment to wipe on uninstall:
; Type: filesandordirs; Name: "{commonappdata}\GoNails\PaxAgent"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
  // Future: check that no other instance of the service is running, etc.
end;

{ Stop and deregister the service BEFORE [Files] copies anything.

  Without this an upgrade silently keeps the old binary: the running service
  holds a lock on pax-agent.exe, Windows refuses the overwrite, and Inno skips
  the file without failing the install. The result looks like a successful
  upgrade — the registry even reports the new version — while the old code
  keeps running. CloseApplications=force does not help here; it closes windowed
  applications, not services.

  install-service.bat re-registers the service afterwards in [Run], so removing
  it here is safe on both fresh installs and upgrades. Errors are ignored: on a
  first install there is simply no service to stop. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{cmd}'), '/C sc stop GoNailsPaxAgent', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Service shutdown is asynchronous — sc returns as soon as the stop is
    accepted, not when the process has exited and released the file. }
  Sleep(4000);
  Exec(ExpandConstant('{cmd}'), '/C sc delete GoNailsPaxAgent', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1000);
end;
