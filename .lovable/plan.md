## Plan

### 1. Fix the blank Internal SOP Gap Analysis

The report has regulatory changes, but `sop_impacts` is empty because the current matching only reads Knowledge Base documents where `doc_type = 'sop'`. Your Knowledge Base currently has `PD RMiT June2023` stored as `rmit_reg`, so the matcher sees no usable internal documents and inserts no impacts.

I will update the report creation logic to:
- Read Knowledge Base documents more broadly instead of only `doc_type = 'sop'`.
- Avoid silently dropping all impacts when no perfect SOP match is found.
- Insert unmatched impact rows with clear wording like `No matching internal document found`, so the Internal SOP Gap Analysis is never blank when comparison changes exist.

### 2. Clarify why the source file itself is not changed

The current publish flow does not edit the attached PDF/DOCX file. It only bumps the Knowledge Base document version and records a note in metadata.

I will make the UI wording clear that:
- Publishing records approved changes and bumps the version.
- The original uploaded file is not automatically rewritten.
- To update the actual file, the user should edit/re-upload it from the Knowledge Base.

### 3. Add Knowledge Base document controls in both card view and table view

You are right: the same controls must exist in table view too.

I will ensure both Knowledge Base views include:
- **Open** document in a new tab.
- **Preview** document in an in-page dialog where supported.
- **Edit** document metadata and manually replace the file.
- Automatic version bump on every edit/save.

This means the card view and table view will have consistent document management actions.

### 4. Keep manual completion on the report page

I will keep the **Confirm Manual Completion** button beside the **Execute** button on the report execution area, as requested earlier.

## Files to update

- `src/lib/compliance.functions.ts`
  - Broaden Knowledge Base matching.
  - Create fallback impact rows instead of blank results.
  - Keep version bump behavior for manual Knowledge Base edits.

- `src/routes/knowledge-base.tsx`
  - Add the same Open / Preview / Edit actions to the table view.
  - Ensure edit/save bumps the version.

- `src/components/approval-workflow.tsx`
  - Keep manual completion beside Execute.
  - Clarify publish/file-update wording.

- `src/components/impacts-tab.tsx` or `src/routes/reports.$reportId.tsx`
  - Improve the empty state so it explains whether no internal documents were found or no impacts were generated.