import React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { defaultSubmitterCopyMessage } from "../../../../shared/submitterCopyEmail.js";

// Keep tokens editable rather than replacing them with the current form/tenant
// names. A null value follows the shared default, including future changes.
export default function FormBuilderSubmitterCopySettings({ formData, setFormData }) {
  const defaultMessage = defaultSubmitterCopyMessage("{{form_name}}", "{{tenant_name}}");
  const message = formData.submitter_copy_email_message ?? defaultMessage;

  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-3"
        title="When enabled, the public form shows an email input and a 'Email me a copy' checkbox at the bottom. Submitters who tick it receive a Word (DOCX) copy of their submission by email."
      >
        <Switch
          id="allow_submitter_email_copy"
          checked={formData.allow_submitter_email_copy}
          onCheckedChange={(checked) => setFormData(current => ({
            ...current,
            allow_submitter_email_copy: checked,
          }))}
          data-testid="switch-allow-submitter-email-copy"
        />
        <Label htmlFor="allow_submitter_email_copy" className="text-sm">
          Allow submitter to email themselves a copy
        </Label>
      </div>

      {formData.allow_submitter_email_copy && (
        <div className="space-y-2" data-testid="submitter-copy-email-message-editor">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="submitter_copy_email_message" className="text-sm">
              Copy email message
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFormData(current => ({
                ...current,
                submitter_copy_email_message: null,
              }))}
              data-testid="button-restore-submitter-copy-message"
            >
              Restore default
            </Button>
          </div>
          <Textarea
            id="submitter_copy_email_message"
            value={message}
            onChange={(event) => {
              const value = event.target.value;
              setFormData(current => ({
                ...current,
                submitter_copy_email_message: value,
              }));
            }}
            rows={6}
            className="min-h-[144px]"
            aria-describedby="submitter-copy-email-message-help"
            data-testid="textarea-submitter-copy-email-message"
          />
          <p id="submitter-copy-email-message-help" className="text-xs text-muted-foreground">
            Plain text sent with the submission copy. Use <code>{"{{form_name}}"}</code> for
            the form name and <code>{"{{tenant_name}}"}</code> for the organisation name.
          </p>
        </div>
      )}
    </div>
  );
}
