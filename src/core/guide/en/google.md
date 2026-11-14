# Google: Gmail, Calendar, Drive, Docs and Sheets
> Connecting the Google services: the app the person creates in Google Cloud once, the 6 steps (with the Developer Preview enrolment), the unverified-app warning and what to check when Google refuses.

Google only lets in apps registered with it, so you create your own once, in Google Cloud, and all five come in with it. The first **Connect** on one of them opens **Your Google app** with the steps:
1. Create a project in Google Cloud.
2. Turn the APIs on (one link turns on all ten: each service's and each one's MCP).
3. Enrol the project in the **Google Workspace Developer Preview Program** (developers.google.com/workspace/preview): Google's MCP servers are still in preview and only answer enrolled projects. The form asks for the project number (in the project's dashboard). Approval usually takes a few days; you can follow the steps and save, but until then the Google connectors fail.
4. Set up the sign-in screen (Google Auth Platform › Get started): app name, email, Audience **External** (or **Internal** on a company Google Workspace account), and your own email under **Test users**.
5. Create the client: type **Desktop app**, with **Use this client for an AI agent** ticked. Without that tick Google refuses the connectors.
6. Paste the **Client ID** and the **Client secret** and click **Save and connect**.

After that the other four are one click. To change the app: **Your Google app**, beside the Google title in the store; changing it disconnects the Google ones, which ask for the login again.

With the app **in testing**, Google asks for the login again every 7 days. To stop that: under Audience, **Publish app**; the login then shows "Google hasn't verified this app", and since the app is your own, it is just **Advanced** and carry on.

Rather not create the app? Composio connects Google without it, but your data passes through its servers: see **composio**.

Gmail searches, reads, drafts and labels, but does not send or delete for good. Drive reads everything and only writes to the files it created or opened.

## When it goes wrong
- "...enrolled in the Google Workspace Developer Preview Program": step 3 is missing. Enrol the project at developers.google.com/workspace/preview and wait a few days. Meanwhile, Composio connects without that step (see **composio**).
- **Your Google app is missing**: click **Connect** on one of them and follow the steps.
- **Needs authorizing**: Google only asks for the login on a call. Click **Authorize**; **Connect again** does not open the browser.
- "Gmail still needs authorizing": the login expired (every 7 days with the app in testing). Click **Authorize**.
- "It refused the login, even renewed": click **Authorize** to sign in again. If it continues, check **Test users** and the client (**Desktop app**, with the AI-agent tick).
- "Permission missing in the login": a box was left unticked on Google's screen. **Authorize** again and tick all of them.
- "An API is not enabled" (SERVICE_DISABLED): turn the named API on in the client's own project and wait a few minutes. Authorizing does not fix it.
- An error on Google's sign-in page: "access_denied" is an email outside **Test users**; "org_internal", an **Internal** app with an outside account; "redirect_uri_mismatch", a client that is not a **Desktop app**; "invalid_client", a wrong ID or secret (change them in **Your Google app**).
- It asks for the login every week: the app is **in testing**; publish it (above).
