/** Public legal page: no app session, JavaScript, credentials or catalog required. */
export const termsPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Terms and Conditions for using Plan Shepherd, a health coverage comparison and planning tool.">
  <title>Terms and Conditions · Plan Shepherd</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #263c35; background: #f7f6f2; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { margin: 0; font-size: 17px; line-height: 1.8; }
    a { color: #285b4d; text-underline-offset: .2em; }
    a:hover { color: #173c35; }
    a:focus-visible { outline: 3px solid #6c9274; outline-offset: 5px; }
    .skip-link { position: absolute; left: 20px; top: -100px; padding: 8px 16px; background: #fff; }
    .skip-link:focus { top: 12px; }
    header, main, footer { width: min(100% - 48px, 800px); margin-inline: auto; }
    header { padding: 32px 0; border-bottom: 1px solid #dfe3d8; }
    .brand { font-family: Georgia, "Times New Roman", serif; font-size: 28px; text-decoration: none; color: #173c35; }
    main { padding-block: 48px; }
    .eyebrow { color: #54654e; font-size: 12px; font-weight: 600; letter-spacing: .13em; text-transform: uppercase; }
    h1, h2 { color: #173c35; font-family: Georgia, "Times New Roman", serif; font-weight: 400; line-height: 1.2; }
    h1 { font-size: clamp(36px, 6vw, 54px); letter-spacing: -.03em; margin: 12px 0 16px; }
    h2 { font-size: 26px; margin: 0 0 14px; }
    p { margin: 0 0 16px; }
    .updated { color: #596756; font-size: 14px; }
    .intro { margin-top: 28px; padding: 24px; background: #e8eee2; border: 1px solid #d6dfcc; border-radius: 10px; }
    .intro p:last-child, section p:last-child { margin-bottom: 0; }
    section { margin-top: 36px; }
    li { margin-block: 8px; }
    ul { padding-left: 24px; }
    footer { padding-block: 24px 40px; border-top: 1px solid #dfe3d8; font-size: 14px; }
    @media (max-width: 480px) { body { font-size: 16px; } header, main, footer { width: calc(100% - 36px); } main { padding-block: 32px; } .intro { padding: 20px; } }
    @media print { :root { background: #fff; color: #000; } header, main, footer { width: 100%; } main { padding-block: 20px; } .skip-link { display: none; } h2 { break-after: avoid; } p, li { orphans: 3; widows: 3; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#terms">Skip to terms</a>
  <header><a class="brand" href="/coverage">Plan Shepherd</a></header>
  <main id="terms" tabindex="-1">
    <div class="eyebrow">Using Plan Shepherd</div>
    <h1>Terms and Conditions</h1>
    <p class="updated">Effective date: <time datetime="2026-09-12">September 12, 2026</time></p>
    <div class="intro">
      <p>Plan Shepherd helps you understand health coverage options and compare anticipated costs. These Terms and Conditions govern your use of the application.</p>
      <p>By using Plan Shepherd, you agree to these terms. If you do not agree, please stop using the application.</p>
    </div>

    <section aria-labelledby="purpose">
      <h2 id="purpose">1. What the service does</h2>
      <p>Plan Shepherd provides informational tools for reviewing coverage, organizing care information, exploring potential eligibility and comparing available plan information. Features and data sources may vary or be unavailable.</p>
      <p>The application does not enroll you in insurance, submit an application or claim, change your coverage, or provide medical, legal, tax or financial advice. It does not recommend a particular plan, clinician or treatment. Using it does not create a clinician-patient or insurance-agent relationship.</p>
    </section>

    <section aria-labelledby="estimates">
      <h2 id="estimates">2. Estimates and coverage decisions</h2>
      <p>Cost estimates, eligibility screens and anticipated-care drafts are preliminary and may be incomplete or inaccurate. Results depend on your entries, assumptions and available source data. Historical care does not establish future medical need, coverage or authorization.</p>
      <p>Confirm premiums, benefits, exclusions, provider networks, drug coverage, prior authorization, enrollment deadlines and eligibility with the insurer, provider or official program before making a decision. The applicable plan documents and official determinations govern your coverage. An estimate is not a quote, promise of payment or guarantee of savings.</p>
    </section>

    <section aria-labelledby="responsibilities">
      <h2 id="responsibilities">3. Your information and responsibilities</h2>
      <p>Use the service only for lawful purposes and only provide information you are authorized to use. You must have the legal capacity to agree to these terms or use the service with an authorized parent or guardian.</p>
      <ul>
        <li>Enter accurate information and review imported records, care assumptions and proposed changes before confirming them.</li>
        <li>Connect only accounts you are authorized to access, and confirm that imported records belong to the person whose coverage you are comparing.</li>
        <li>Protect your device and provider or insurer credentials. Do not enter account passwords into the assistant or other application text fields.</li>
        <li>Keep any copies you need and complete enrollment or other required actions directly with the appropriate organization.</li>
      </ul>
    </section>

    <section aria-labelledby="connections">
      <h2 id="connections">4. Connected services and external sources</h2>
      <p>When available, you may authorize a connection to a provider or insurer to import permitted records. That authorization is separate from these terms. You may use manual entry without connecting an account. Manage or revoke ongoing permissions through the connected organization's account settings.</p>
      <p>External websites, data sources and connected services have their own terms and privacy practices. Their availability, accuracy and completeness are outside Plan Shepherd's control. A connection or link does not imply an endorsement or partnership.</p>
    </section>

    <section aria-labelledby="session">
      <h2 id="session">5. Session information and processing</h2>
      <p>Plan Shepherd is designed to keep your entries, imported records, access tokens, conversation and results in the active application session rather than a saved patient account. Information needed to perform a requested operation may be processed by the application server and relevant connected services.</p>
      <p>Clearing or reloading the session resets the application's working information. This does not delete records held by your provider or insurer, revoke permissions in those accounts, or remove copies you print or save. Third-party processing and retention are governed by the applicable service's practices; clearing this application does not control those systems.</p>
    </section>

    <section aria-labelledby="assistant">
      <h2 id="assistant">6. Optional assistant</h2>
      <p>If enabled, the assistant can explain application concepts and propose supported changes to your entries. Your messages and the context needed for a request may be sent to a configured AI processing service. Review every proposed change before accepting it. AI output can be incorrect and does not replace professional advice or an official coverage determination.</p>
    </section>

    <section aria-labelledby="acceptable-use">
      <h2 id="acceptable-use">7. Acceptable use and content</h2>
      <p>Do not attempt to access another person's information without authorization, bypass security or access restrictions, introduce malicious code, disrupt the service, or use it to violate others' rights.</p>
      <p>You may use the application and its output for your own coverage planning, subject to these terms and any applicable source restrictions. Plan documents, third-party data, names and trademarks remain subject to their owners' rights. These terms do not transfer ownership of your personal information or third-party content.</p>
    </section>

    <section aria-labelledby="availability">
      <h2 id="availability">8. Availability and limitations</h2>
      <p>The service is provided on an “as is” and “as available” basis. To the extent permitted by applicable law, Plan Shepherd disclaims implied warranties of merchantability, fitness for a particular purpose and non-infringement, and does not warrant uninterrupted availability, error-free results or complete source data.</p>
      <p>To the extent permitted by applicable law, Plan Shepherd is not liable for indirect, incidental, special or consequential losses arising from use of the service. Nothing in these terms excludes liability or limits rights that cannot lawfully be excluded or limited.</p>
    </section>

    <section aria-labelledby="changes">
      <h2 id="changes">9. Changes and ending use</h2>
      <p>Features may change or be discontinued, and access may be restricted to address misuse, security issues or legal requirements. You may stop using the service at any time and clear your active session.</p>
      <p>Updated terms will be published on this page with a new effective date. Changes apply prospectively. Review the current terms before continuing to use the service; any notice or consent required by applicable law will still apply.</p>
    </section>
  </main>
  <footer><a href="/coverage">Return to Plan Shepherd</a></footer>
</body>
</html>`;
