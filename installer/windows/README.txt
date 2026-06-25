GoNails PAX Agent — Windows
================================

The agent runs as a Windows Service named "GoNailsPaxAgent" and starts
automatically on boot. After install, the configuration UI opens in your
browser at http://127.0.0.1:9876/.

First-time setup:
  1. The agent shows a 6-character pairing code in the UI.
  2. In the cloud dashboard: Settings -> Payment Device -> PAX Agent ->
     "Add Agent" -> enter the code.
  3. The agent receives its credentials and connects automatically.

Open the UI later:
  Start Menu -> "GoNails PAX Agent"
  (or double-click the desktop shortcut if you ticked it during install)

Service control:
  Open Services (services.msc), find "GoNailsPaxAgent" -> right-click ->
  Start / Stop / Restart.

Logs:
  C:\ProgramData\GoNails\PaxAgent\logs\

Uninstall:
  Settings -> Apps -> "GoNails PAX Agent" -> Uninstall
  (this also stops + removes the service)

Support:
  Include your Office ID (visible in the UI status panel) when contacting
  support.
