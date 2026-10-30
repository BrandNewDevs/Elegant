# Balanced TL;DR regression checks

One local production-pipeline run per synthetic fixture with `gemma3:4b-it-q4_K_M`, prompt `readable-summary-v15`, temperature 0 and unchanged request limits. Linux timings are not M4 acceptance measurements.

## ambiguous-ownership

You: I will ask the team about ownership tomorrow. The guide is unassigned. We have not set a deadline.

Runtime: 43.2s; calls: 7; words: 19.

**You**

- The permission guide needs an update before the demo, but I cannot take it on.
- The guide is unassigned.
- We have not set a deadline.
- I will ask the team about ownership tomorrow.

**Speaker 1**

- Maybe Speaker 2 could update it, if they have time; that is a suggestion, not an assignment.
- I can commit to reviewing the guide after someone writes it.
- I am not committing to writing it.

**Speaker 2**

- I need to check my workload before I can say yes.
- Please do not list me as the owner.

## changed-decision

Friday replaces Monday, and Markdown replaces PDF; these are the final decisions. Speaker 1: I will run the offline test again on Wednesday. The offline test failed.

Runtime: 36.5s; calls: 5; words: 27.

**You**

- My initial proposal is to launch on Monday with PDF export.
- The offline test failed.
- We need to revise both choices.
- Agreed; Friday replaces Monday, and Markdown replaces PDF; these are the final decisions.

**Speaker 1**

- I agree with Monday and PDF for now, provided the offline test passes.
- Then I propose Friday instead, and Markdown export because that already works without an external service.
- I will run the offline test again on Wednesday.
- We did not set a calendar date for Friday.

## straightforward

We agree to keep the first release English only. You: I will write the permission guide by Thursday. The release date is still undecided.

Runtime: 26.3s; calls: 5; words: 24.

**You**

- The desktop settings screen is ready.
- I will write the permission guide by Thursday.
- We agree to keep the first release English only.
- We are not adding calendar integration.

**Speaker 1**

- I completed the search tests.
- I will review your permission guide on Friday.
- The release date is still undecided.

## Review and limits

All three generated successfully within the 90-word cap, with structurally valid references and matching Participant attribution. Ownership ambiguity now includes unassigned status and no deadline; the changed decision retains Friday/Markdown and Wednesday retesting. The release-progress overview now includes English-only scope, the Thursday writing commitment and the unresolved release date. Friday review and excluded calendar integration remain in Participant points rather than the overview. No standalone acknowledgements remain in these Participant outputs.

The rules are English cues, not semantic consolidation. Source wording remains conversational. Three sentences cannot contain every important point; Participant sections preserve the remaining claims. These runs do not establish broad quality, real-Recording accuracy, or target-device performance. Typechecking and 37 focused tests passed; CI covers app and native suites.
