# Security

Rule group `S`. Controls are in [`../standard.md`](../standard.md).

**S1** Authorization decisions are made by one policy component, and it denies by default.

**S2** A query cannot be built without a tenant or subject scope.

**S3** Cross-tenant denial is proven by tests that attempt the access.

**S4** Deprecated: retired, kept so existing citations stay valid.

**S5** Deprecated: retired, kept so existing citations stay valid.

**S6** Deprecated: retired, kept so existing citations stay valid.

**S7** Data is encrypted in transit and at rest, with stated key custody and rotation.

**S8** A secret never enters version control, and both pre-commit and CI scan for it.
