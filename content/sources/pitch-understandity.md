---
source: "Understandity project documentation, 24 October 2026: README.md (How a card works; Before and after; Why local; Architecture; Make your own course), docs/submission.md, docs/demo-script.md; main at 0e6deff, including af2eb49 and cd31813. Product behavior updated from Max Postnikov's decision of 24 October 2026. Original summary by Codex; project measurements, not a learning-outcomes study."
subject: learning
---
Understandity is an offline-first, open-source tutor for young learners. Understanding is the key. Repeating an explanation or guessing correctly does not show why something happens. The learner must explain a cause and apply it to an unfamiliar case. This is the project's teaching design, not proof that children learn better: its reported comparison used scripted answers, not children.

A card begins with a surprising question in a chosen world. The learner predicts aloud, reads a short causal explanation, changes one condition, and explains a new case without hints. Fantasy and Anime change the setting, not the underlying facts. The new case checks whether the learner can use the idea beyond the example already shown.

Voice answers are transcribed locally and confirmed by the learner before judgement. A recognition error is not a reasoning error. The tutor uses an answer key: it confirms a correct cause, asks why after a bare prediction, and offers a counterexample or hint otherwise. It is instructed to withhold the key before the learner finds it. With the same Gemma model, Understandity judged 16/16 scripted answers correctly; a plain helpful-assistant prompt judged 7/16 correctly. This small text-only comparison does not establish classroom effectiveness, and the tutor still produced a faulty counterexample.

In the Offline profile, the prepared lesson runs on the family computer: Gemma handles tutoring, Whisper transcribes, and Kokoro speaks English. Cloud calls are blocked, pictures ship as files, and no account is needed. Installation downloads models beforehand. Recordings are deleted after transcription; text dialogue logs remain locally. Keeping the tutor loaded reduced a measured Gemma turn from 2.9 seconds to 0.7 seconds on the Mac Studio, not a measured complete voice exchange on every laptop.

Models can invent incorrect facts or keys. Courses open immediately, and Make your own course produces a model draft. Fast generation does not verify its claims. Before relying on a lesson, compare its facts and answer keys with sources. Generation can use a local model, or an online model with a key in the Online profile.
