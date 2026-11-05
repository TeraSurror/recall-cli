import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Changeset } from "../changes/changeset.ts";
import { changesetDiff, diffStats, summarizeChanges } from "../changes/changeset.ts";
import type { ApprovalDecision } from "../agent/approval.ts";
import { DiffView } from "./Markdown.tsx";

/** `always`: approve this and every later change in the session. */
export type ReviewResult = ApprovalDecision & { always?: boolean };

export function DiffReview({ cs, onDecide, rows }: { cs: Changeset; onDecide: (d: ReviewResult) => void; rows: number }) {
  const [full, setFull] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const stats = diffStats(cs);
  const diff = changesetDiff(cs, 2);

  useInput(
    (input, key) => {
      // Only explicit keys apply a change — never Enter or common letters typed by accident.
      if (input === "y") onDecide({ approved: true });
      else if (input === "A") onDecide({ approved: true, always: true });
      else if (input === "n" || input === "r" || key.escape) onDecide({ approved: false });
      else if (input === "f") setFeedback("");
      else if (input === "d") setFull((f) => !f);
    },
    { isActive: feedback === null },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        <Text color="yellow" bold>✎ {cs.title}</Text>
        <Text color="gray">  {cs.vault} · {stats.files} file(s) · </Text>
        <Text color="green">+{stats.added}</Text> <Text color="red">−{stats.removed}</Text>
      </Text>
      {cs.changes.length > 1 && (
        <Box flexDirection="column" marginBottom={1}>
          {summarizeChanges(cs).map((s) => (
            <Text key={s} color="gray">  {s}</Text>
          ))}
        </Box>
      )}
      <DiffView diff={diff} maxLines={full ? undefined : Math.max(8, rows - 14)} />
      {feedback === null ? (
        <Text>
          <Text bold color="green">y</Text>
          <Text color="gray"> apply  </Text>
          <Text bold color="green">A</Text>
          <Text color="gray"> apply all (session)  </Text>
          <Text bold color="red">n</Text>
          <Text color="gray"> reject  </Text>
          <Text bold color="cyan">f</Text>
          <Text color="gray"> reject with feedback  </Text>
          <Text bold>d</Text>
          <Text color="gray"> {full ? "collapse" : "full diff"}</Text>
        </Text>
      ) : (
        <Box>
          <Text color="cyan">feedback › </Text>
          <TextInput
            value={feedback}
            onChange={setFeedback}
            onSubmit={(v) => onDecide({ approved: false, feedback: v.trim() || undefined })}
            placeholder="what should change? (enter to send, empty to just reject)"
          />
        </Box>
      )}
    </Box>
  );
}
