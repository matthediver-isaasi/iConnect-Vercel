import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AtSign, Check } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { boardMentionOptions, insertMention, mentionTrigger, retainedMentions } from "./boardMentionHelpers.mjs";
import "./boardMentions.css";

export default function BoardMentionTextarea({ value, onChange, mentions, onMentionsChange, members = [], disabled, ...props }) {
  const textarea = useRef(null);
  const listId = useId();
  const hintId = useId();
  const [trigger, setTrigger] = useState(null);
  const [active, setActive] = useState(0);
  const options = useMemo(() => boardMentionOptions(members), [members]);
  const matches = trigger ? options.filter((member) =>
    `${member.label} ${member.email}`.toLocaleLowerCase().includes(trigger.query.toLocaleLowerCase())) : [];
  const expanded = Boolean(trigger && !disabled);
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));
  useEffect(() => {
    if (!expanded || !matches.length) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, listId, activeIndex, matches.length]);

  const updateTrigger = (content, caret) => { setTrigger(mentionTrigger(content, caret)); setActive(0); };
  const pick = (member) => {
    if (!trigger) return;
    const next = insertMention(value, trigger, member);
    const nextMentions = retainedMentions(next.content, [...mentions, { id: member.id, label: member.label }], members);
    onChange(next.content);
    onMentionsChange(nextMentions);
    setTrigger(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return <div className="relative">
    <Textarea {...props} ref={textarea} value={value} disabled={disabled}
      aria-autocomplete="list" aria-haspopup="listbox" aria-controls={expanded ? listId : undefined}
      aria-expanded={expanded} aria-activedescendant={expanded && matches.length ? `${listId}-${activeIndex}` : undefined}
      aria-describedby={hintId}
      onChange={(event) => {
        const content = event.target.value;
        onChange(content);
        onMentionsChange(retainedMentions(content, mentions, members));
        updateTrigger(content, event.target.selectionStart);
      }}
      onClick={(event) => updateTrigger(value, event.currentTarget.selectionStart)}
      onBlur={() => setTrigger(null)}
      onKeyUp={(event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateTrigger(value, event.currentTarget.selectionStart);
      }}
      onKeyDown={(event) => {
        if (!expanded || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setTrigger(null); }
        else if (matches.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
        } else if (matches.length && event.key === "Enter" && !event.shiftKey) {
          event.preventDefault(); pick(matches[activeIndex]);
        }
      }} />
    {expanded && <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md">
      <p className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground"><AtSign className="h-3.5 w-3.5" />Mention a board member</p>
      <div id={listId} role="listbox" aria-label="Board members" className="project-mention-options">
        {!matches.length && <p role="status" className="px-3 py-4 text-sm text-muted-foreground">No matching board members.</p>}
        {matches.map((member, index) => <button type="button" role="option" tabIndex={-1} key={member.id}
          id={`${listId}-${index}`} aria-selected={index === activeIndex}
          data-active={index === activeIndex} className="project-mention-option flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(member)}>
          <span className="min-w-0 flex-1"><span className="block break-words font-medium">{member.label}</span>{member.email !== member.label && <span className="block truncate text-xs text-muted-foreground">{member.email}</span>}</span>
          {mentions.some((mention) => mention.id === member.id) && <Check className="h-3.5 w-3.5 shrink-0" />}
        </button>)}
      </div>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Arrow keys to browse · Enter to choose · Esc to close</p>
    </div>}
    <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">Type @ and choose a board member to send a personal mention.</p>
  </div>;
}
