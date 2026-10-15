# Change workflow

Make code changes on a feature branch and submit a pull request. Do not push changes directly to `main`.

# Product invariants

- Organization is a hierarchy of containers (projects/folders/titles) and chats. Containers may contain containers and chats; chats are leaves, never parents.
- A chat's container is chosen at creation and cannot be changed afterwards, including moving to or from the top level. Existing containers cannot be moved either.
- Renaming, archiving, restoring, deleting, or redesigning the UI must not introduce moving or reparenting. Archive/restore preserves the original container.
- Enforce fixed parentage in the UI, API, storage, and regression tests. Do not remove or relax these protections unless the user explicitly changes this requirement.
- Do not infer additional organization features from requests about unrelated features.
