# Background UI checks

Build with `npm run build`, then run `node scripts/qa-background.mjs`. The runner starts
Electron with `--qa-background`, a fresh temporary data directory, fake engines and two
separately allocated ports. It never sends operating-system mouse or keyboard input.
The window stays hidden and unfocusable; Playwright drives its DOM through Electron's
DevTools connection and captures the rendered page. Tray, notifications, phone restoration,
saved server restoration, update checks and protocol-client registration are suppressed.

The app rejects QA startup without an existing empty absolute data directory, fake engines,
and two distinct non-default ports. Normal application profiles, their parents and their
descendants are refused. QA data is deliberately retained in the reported temporary path
for investigation; it is never the normal workspace.

The smoke flow checks the seeded workspace, agent profile, Open DM action, Settings,
Team board and Usage. Each capture verifies that every app window remains hidden,
unfocused and unfocusable. Show and focus events also fail the run. A failing assertion
sets a nonzero exit code and retains the report, failure screenshot and Playwright trace.
Artifacts default to `.tucano-local/audit/background-qa`; pass an output directory as the
first argument. Reports include the source commit, tracked-diff status, actual executable,
app and Electron versions, scratch data, ports, completed checks and renderer errors.

Set `TUCANO_ELECTRON` to an absolute packaged executable to check an installed build.
Leave it unset to check the built source app. The script always launches a new isolated
instance and closes it afterward, so it can run beside the regular app. Port allocation
is released immediately before launch; a competing bind must cause a failed startup,
not a retry using an application's normal ports.

`--background` is a separate normal-use launch option: it shows the window without
activating it and leaves real workspace behavior intact. A second invocation carrying
that option does not raise an existing window.

These checks cover rendered navigation and isolation. They do not establish accessibility,
real engine authentication, operating-system dialogs, or physical input behavior. Add
focused DOM interactions and assertions to the runner as features are audited; retain
unit and integration regressions for concurrency and persistence.

The approach uses Electron's [hidden BrowserWindow support](https://www.electronjs.org/docs/latest/api/browser-window)
and Playwright's [Electron automation](https://playwright.dev/docs/api/class-electron).
