# Elegant

A personal macOS app that notices when you are in an online call, offers to record it, and produces a Transcript and Summary. Processing is local by default, with optional Gemini text processing as described in ADR 0003. Audio stays on the Mac.

## Language

**Meeting**:
An online call you are in, from the moment the app detects it. A Meeting exists whether or not it ends up recorded.
_Avoid_: Call, session

**Detection**:
The app noticing that you are probably in a Meeting, based on an app using the microphone (any `.app` bundle except built-in and user-configured ignores).
_Avoid_: Trigger, discovery

**Prompt**:
The overlay shown after a Detection that asks whether to record the Meeting.
_Avoid_: Popup, notification, banner

**Recording**:
The captured audio of a Meeting, kept as one track for you and one for everyone else.
_Avoid_: Capture, audio file

**Transcript**:
The text of what was said in a Recording, attributed to Participants.
_Avoid_: Notes, captions

**Summary**:
The condensed account of a Meeting produced from its Transcript: a TL;DR and what each Participant said.
_Avoid_: Notes, minutes, recap

**Participant**:
A person who speaks in a Meeting, including you. You appear as "You" until you give your name (in onboarding or in Settings); others start out unnamed ("Speaker 1", "Speaker 2") until you give them a name.
_Avoid_: Attendee
