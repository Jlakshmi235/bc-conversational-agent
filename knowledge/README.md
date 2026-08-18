# Knowledge base

This folder contains the curated conversational knowledge used by the breast-cancer risk educator.

## Runtime policy
- `prompts/system-prompt.md` is always active.
- `modules/00_scope-and-safety.md` is always included or enforced equivalently in code.
- `modules/01_explain-risk.md` is used for the initial explanation.
- Exactly one branch module is selected by application logic: `03_low-average-risk-pathway.md` or `04_elevated-risk-pathway.md`. The LLM must not choose the branch.
- `02_understanding-and-concerns.md`, `05_gail-limitations.md`, and `06_clinical-discussion.md` are retrieved when relevant to the conversation stage/topic.

## Source registry
`sources.json` records which vetted source supports each module. Add full URLs/DOIs and access dates once the final source set is frozen.
