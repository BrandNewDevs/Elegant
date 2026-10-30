# TL;DR priority smoke comparison

Two synthetic fixtures, one run each through the production Summary interface. These are Linux development observations, not M4 measurements or broad quality acceptance.

Model: `gemma3:4b-it-q4_K_M`; temperature 0; 8,192-token context; 5,500-byte request limit. Expectations are not sent to the model.

## changed-decision

Before:

You: My initial proposal is to launch on Monday with PDF export. Speaker 1: Then I propose Friday instead, and Markdown export because that already works without an external service. Agreed; Friday replaces Monday, and Markdown replaces PDF; These are the final decisions.

After:

Friday replaces Monday, and Markdown replaces PDF; these are the final decisions. Speaker 1: I will run the offline test again on Wednesday. We need to revise both choices.

Before: 42.3s / 5 calls. After: 39.0s / 5 calls. No controlled latency conclusion from a single run.

## fragmented-status-update

Before:

We use Gemma 3 4B locally through Ollama. It creates a TL;DR, organizes key points by speaker, and answers questions with Transcript references. The tests are not finished; This call is one of the tests.

After:

We use Gemma 3 4B locally through Ollama. It creates a TL;DR, organizes key points by speaker, and answers questions with Transcript references. The tests are not finished; this call is one of the tests.

Before: 16.2s / 4 calls. After: 14.9s / 4 calls. No controlled latency conclusion from a single run.

## Review

The changed-decision overview now leads with Friday/Markdown and includes Speaker 1’s Wednesday retest commitment. Earlier proposals no longer occupy the overview. The third sentence still repeats a background need to revise choices, and the unspecified calendar date remains only in Participant points. This is not complete semantic consolidation.

The fragmented update retains local Gemma/Ollama, AI features and unfinished testing, omits the noisy ending and improves sentence-internal capitalization. Reference ordinals and Participant attribution are structurally valid in both outputs; source review supports these examples. Participant points remain unchanged by this refinement.

Typechecking and 34 focused tests passed. CI runs app and native suites. No extra model stage, storage migration, model change or new runtime dependency.
