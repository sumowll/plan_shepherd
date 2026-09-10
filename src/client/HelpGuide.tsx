export function HelpGuide() {
  return <section className="help-guide" aria-label="Help with forms and insurance terms">
    <h3>Help you can use any time</h3>
    <p>You can complete the forms without the assistant. Open a topic below for help.</p>
    <details><summary>What do I need to get started?</summary><p>Start with your birth date and address. Add the doctors you want to keep and the medicines on your prescription labels. Optional questions can wait if you are unsure.</p></details>
    <details><summary>How do I connect my records?</summary><p>Choose your provider or insurer, sign in in the separate window, then return here. Check the name and birth date before adding any records. If sign-in does not work, use “Add details manually” in Your care.</p></details>
    <details><summary>What if I do not know a cost or code?</summary><p>Leave optional amounts and medical codes blank. A blank cost means “not known”; enter $0 only when you know there is no cost. You can still review plans with missing information.</p></details>
    <details><summary>What do premium, deductible, copay, and coinsurance mean?</summary><dl>
      <dt>Premium</dt><dd>The regular payment to keep your coverage, even when you do not receive care.</dd>
      <dt>Deductible</dt><dd>The amount you pay for covered care before the plan begins paying for services subject to that deductible. Some services may be covered sooner.</dd>
      <dt>Copay</dt><dd>A fixed payment for a covered service, such as $25 for a visit.</dd>
      <dt>Coinsurance</dt><dd>Your percentage of a covered service’s cost. For example, 20% of $100 is $20.</dd>
    </dl><a href="https://www.healthcare.gov/glossary/deductible/" target="_blank" rel="noopener noreferrer">Read the HealthCare.gov explanation (opens a new tab)</a></details>
    <details><summary>What is an allowed amount?</summary><p>The amount the plan recognizes for a covered service. It can differ from a doctor’s bill or a cash price. If you are unsure which amount you have, leave the price type as “Not sure.”</p><a href="https://www.healthcare.gov/glossary/allowed-amount/" target="_blank" rel="noopener noreferrer">Read the HealthCare.gov definition (opens a new tab)</a></details>
    <details><summary>Why is my estimate incomplete?</summary><p>Some prices, premiums, or coverage details still need confirmation. The known subtotal includes only amounts we can calculate. Missing amounts are never counted as $0. Open the plan’s cost details to see what is missing.</p></details>
    <details><summary>Can someone help me review my options?</summary><p>Use “Print comparison” to make a paper copy or save a PDF for someone you trust. Your comparison may include doctor and prescription names. For questions about a plan’s actual coverage, contact the insurer using its plan documents.</p></details>
  </section>;
}
