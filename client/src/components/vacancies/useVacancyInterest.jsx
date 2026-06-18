import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

/**
 * Shared express-interest flow used by both /MemberGroupDetail and the Volunteer
 * Board. For form-linked vacancies it navigates to FormView (slug, member_id,
 * vacancy_id); otherwise it opens the in-page message dialog and creates a
 * VacancyApplication. Render <VacancyInterestDialog interest={...} /> alongside
 * the consuming page to surface the dialog.
 */
export function useVacancyInterest({ memberInfo, formSlugById }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [interestVacancy, setInterestVacancy] = useState(null);
  const [interestMessage, setInterestMessage] = useState("");

  const handleExpressInterest = (vacancy) => {
    if (vacancy.application_form_id) {
      const slug = formSlugById?.get(vacancy.application_form_id);
      if (slug && memberInfo?.id) {
        navigate(
          `${createPageUrl("FormView")}?slug=${encodeURIComponent(
            slug
          )}&member_id=${encodeURIComponent(
            memberInfo.id
          )}&vacancy_id=${encodeURIComponent(vacancy.id)}`
        );
        return;
      }
      toast.error(
        "This vacancy's application form is currently unavailable. Please try again later."
      );
      return;
    }
    setInterestVacancy(vacancy);
    setInterestMessage("");
  };

  const expressInterestMutation = useMutation({
    mutationFn: async () => {
      if (!memberInfo?.id) throw new Error("You must be signed in to express interest");
      if (!interestVacancy?.id) throw new Error("No vacancy selected");
      return base44.entities.VacancyApplication.create({
        vacancy_id: interestVacancy.id,
        message: interestMessage.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["my-vacancy-applications", memberInfo?.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["vacancy-applicants", interestVacancy?.id],
      });
      setInterestVacancy(null);
      setInterestMessage("");
      toast.success("Interest registered. The group admins will be in touch.");
    },
    onError: (error) => {
      toast.error(
        "Failed to express interest: " + (error?.message || "Unknown error")
      );
    },
  });

  const closeInterest = () => {
    setInterestVacancy(null);
    setInterestMessage("");
  };

  return {
    interestVacancy,
    interestMessage,
    setInterestMessage,
    handleExpressInterest,
    closeInterest,
    expressInterestMutation,
  };
}

export function VacancyInterestDialog({ interest }) {
  const {
    interestVacancy,
    interestMessage,
    setInterestMessage,
    closeInterest,
    expressInterestMutation,
  } = interest;

  return (
    <Dialog
      open={!!interestVacancy}
      onOpenChange={(open) => {
        if (expressInterestMutation.isPending) return;
        if (!open) closeInterest();
      }}
    >
      <DialogContent className="max-w-lg" data-testid="dialog-express-interest">
        <DialogHeader>
          <DialogTitle>Express interest</DialogTitle>
          <DialogDescription>
            Let the group admins know you're interested in "{interestVacancy?.role_title}".
            You can add an optional message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="interest-message">Message (optional)</Label>
          <Textarea
            id="interest-message"
            value={interestMessage}
            onChange={(e) => setInterestMessage(e.target.value)}
            rows={4}
            placeholder="Tell them a bit about why you're interested."
            data-testid="input-interest-message"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={closeInterest}
            disabled={expressInterestMutation.isPending}
            data-testid="button-cancel-interest"
          >
            Cancel
          </Button>
          <Button
            onClick={() => expressInterestMutation.mutate()}
            disabled={expressInterestMutation.isPending}
            data-testid="button-submit-interest"
          >
            {expressInterestMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-2" />
            )}
            Express interest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
