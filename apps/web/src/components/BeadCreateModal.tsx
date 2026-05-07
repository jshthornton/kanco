import { useState } from "react";
import type { BeadIssueType } from "@kanco/shared";

export interface BeadCreateValues {
  title: string;
  description?: string;
  issue_type: BeadIssueType;
  priority?: number;
  labels?: string[];
  parent?: string;
  assignee?: string;
  design?: string;
  acceptance?: string;
  notes?: string;
  due?: string;
  ready: boolean;
}

interface Props {
  defaultParent?: string;
  submitting?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (v: BeadCreateValues) => void;
}

const ISSUE_TYPES: BeadIssueType[] = [
  "task",
  "bug",
  "feature",
  "chore",
  "epic",
  "decision",
  "spike",
  "story",
  "milestone",
];

export function BeadCreateModal({ defaultParent, submitting, error, onCancel, onSubmit }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueType, setIssueType] = useState<BeadIssueType>("task");
  const [priority, setPriority] = useState<string>("2");
  const [labelsRaw, setLabelsRaw] = useState("");
  const [parent, setParent] = useState(defaultParent ?? "");
  const [assignee, setAssignee] = useState("");
  const [design, setDesign] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [notes, setNotes] = useState("");
  const [due, setDue] = useState("");
  const [ready, setReady] = useState(true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const labels = labelsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      issue_type: issueType,
      priority: priority === "" ? undefined : Number(priority),
      labels: labels.length ? labels : undefined,
      parent: parent.trim() || undefined,
      assignee: assignee.trim() || undefined,
      design: design.trim() || undefined,
      acceptance: acceptance.trim() || undefined,
      notes: notes.trim() || undefined,
      due: due.trim() || undefined,
      ready,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Create bead</h2>
          <button className="close-btn" onClick={onCancel} aria-label="Close">×</button>
        </header>
        <form onSubmit={submit} className="modal-body">
          <label>
            Title*
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary"
              required
            />
          </label>
          <label>
            Description
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What needs to happen"
            />
          </label>
          <div className="modal-row">
            <label>
              Type
              <select
                value={issueType}
                onChange={(e) => setIssueType(e.target.value as BeadIssueType)}
              >
                {ISSUE_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              Priority (0–4)
              <input
                type="number"
                min={0}
                max={4}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </label>
          </div>
          <label>
            Labels (comma-separated)
            <input
              value={labelsRaw}
              onChange={(e) => setLabelsRaw(e.target.value)}
              placeholder="frontend, urgent"
            />
          </label>
          <div className="modal-row">
            <label>
              Parent bead id
              <input
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                placeholder="bd-…"
              />
            </label>
            <label>
              Assignee
              <input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="@user"
              />
            </label>
          </div>
          <label>
            Design notes
            <textarea
              rows={3}
              value={design}
              onChange={(e) => setDesign(e.target.value)}
            />
          </label>
          <label>
            Acceptance criteria
            <textarea
              rows={3}
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
            />
          </label>
          <label>
            Notes
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <label>
            Due (e.g. +2d, 2026-06-01)
            <input value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <fieldset className="modal-ready">
            <legend>Is this ready to work on?</legend>
            <label>
              <input
                type="radio"
                name="ready"
                checked={ready}
                onChange={() => setReady(true)}
              />
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="ready"
                checked={!ready}
                onChange={() => setReady(false)}
              />
              No — block with manual gate ("needs more human input")
            </label>
          </fieldset>
          {error && <p className="error">{error}</p>}
          <footer className="modal-footer">
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={!title.trim() || submitting}>
              {submitting ? "Creating…" : "Create"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
