
**Project Name**
Solvagence Enterprise KnowledgeOps RAG Assistant

**What It Is**
This project is a real RAG-based enterprise knowledge assistant. It answers business questions only from approved company documents, shows source citations, supports document approval workflow, and can use PostgreSQL + pgvector for vector search.

**Core Use Cases**

1. **HR Assistant**
Helps employees and HR teams answer policy questions from approved HR documents.

Examples:
- How many paid leaves do employees get?
- Can employees work remotely?
- What proof is required for sick leave?
- What is the notice period?
- When are performance reviews conducted?
- What is the payroll cutoff date?

Documents used:
- Employee handbook
- Expense policy
- Code of conduct

2. **Support Assistant**
Helps support teams answer SLA, ticket handling, and incident response questions.

Examples:
- What is the SLA for a P1 issue?
- How often should clients be updated during a P1 incident?
- What details must a support ticket include?
- When should SLA breach risk be escalated?
- What is required in a production incident report?

Documents used:
- Support SLA policy
- IT security policy

3. **Sales Assistant**
Helps sales teams qualify leads, follow pricing approval rules, and prepare proposals.

Examples:
- When does a sales lead become qualified?
- When is a lead high priority?
- Who approves discounts above 15%?
- What must be included in a proposal?
- What is required before sales handoff to delivery?

Documents used:
- Lead qualification playbook

4. **Client Delivery Assistant**
Helps delivery and project teams manage onboarding, delivery governance, and escalations.

Examples:
- What documents are required before client onboarding?
- When should the kickoff call be scheduled?
- What must weekly status reports include?
- When should a project be escalated?
- What is required for escalation closure?

Documents used:
- Client delivery SOP
- Project escalation matrix

5. **Compliance / Policy Assistant**
Helps answer questions about conduct, confidentiality, vendor gifts, data handling, and reporting misconduct.

Examples:
- What gifts must be reported?
- Can confidential information be discussed publicly?
- Where can misconduct be reported?
- What happens if code of conduct is violated?

Documents used:
- Code of conduct
- IT security policy

**Admin / Knowledge Management Use Cases**

6. **Document Upload and Approval**
Admins can upload new documents as Draft. Documents are not searchable until approved.

Flow:
- Upload document
- Status: Draft
- Reviewer/admin adds comments
- Admin approves document
- Only then it becomes searchable in RAG

7. **Controlled Knowledge Publishing**
Prevents unapproved or draft documents from being used in answers.

Business value:
- Reduces misinformation
- Protects compliance
- Ensures only verified policies are used

8. **Reviewer Workflow**
Reviewers can inspect documents and add comments before approval.

Use case:
- Legal review
- HR review
- Delivery head review
- Security review

9. **Document Versioning**
When content changes, previous versions are stored.

Use case:
- Track policy changes
- Restore older versions
- Maintain audit trail

10. **Audit Log**
Every question and answer is logged with source and status.

Use case:
- Compliance review
- Usage monitoring
- Client trust
- Quality improvement

**Real RAG Technical Use Cases**

11. **Vector Search with pgvector**
Approved document chunks are embedded and stored in PostgreSQL + pgvector.

Retrieval modes:
- `pgvector-hybrid`: real vector DB search
- `semantic-hybrid`: semantic search without DB
- `keyword-bm25`: offline fallback mode with BM25 lexical scoring, metadata boosts, and diversity reranking

12. **Citation-Based Answers**
Every answer includes source document, department, version, owner, reviewed date, and matched clause.

Business value:
- User can verify answer
- Reduces hallucination risk
- Builds enterprise trust

13. **Unknown Question Refusal**
If answer is not found in approved documents, system says:

```text
I don't know based on the document.
```

Business value:
- Prevents AI from inventing answers
- Safer for enterprise use

**One-Line Pitch**
Solvagence KnowledgeOps is an enterprise RAG assistant that converts approved business documents into a secure, searchable, citation-backed AI knowledge system for HR, Sales, Support, and Delivery teams.
