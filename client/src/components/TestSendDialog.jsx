import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Mail, Search, Users, Loader2, TestTube2, X } from "lucide-react";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmailList(text) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  (text || "")
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((p) => {
      const lower = p.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      if (EMAIL_REGEX.test(p)) valid.push(p);
      else invalid.push(p);
    });
  return { valid, invalid };
}

export default function TestSendDialog({
  open,
  onOpenChange,
  title = "Send Test Email",
  description,
  onSend,
  sending = false,
  testIdSuffix = "",
}) {
  const [mode, setMode] = useState("manual");
  const [emailsText, setEmailsText] = useState("");
  const [emailError, setEmailError] = useState("");
  const [members, setMembers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setMode("manual");
      setEmailsText("");
      setEmailError("");
      setMembers([]);
      setSearchQuery("");
      setSearchResults([]);
    }
  }, [open]);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/members/search?q=${encodeURIComponent(searchQuery)}&limit=10`,
          { credentials: "include", signal: ctrl.signal }
        );
        if (res.ok) {
          const data = await res.json();
          setSearchResults(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          console.error("Failed to search members:", e);
          setSearchResults([]);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [searchQuery]);

  const addMember = (member) => {
    if (!member?.email) return;
    const emailLower = member.email.toLowerCase();
    setMembers((prev) =>
      prev.some((m) => (m.email || "").toLowerCase() === emailLower)
        ? prev
        : [...prev, member]
    );
    setSearchQuery("");
    setSearchResults([]);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const removeMember = (email) => {
    const emailLower = (email || "").toLowerCase();
    setMembers((prev) =>
      prev.filter((m) => (m.email || "").toLowerCase() !== emailLower)
    );
  };

  const recipients =
    mode === "manual"
      ? parseEmailList(emailsText).valid
      : members.map((m) => m.email).filter(Boolean);

  const canSend = recipients.length > 0 && !sending;

  const handleSend = async () => {
    if (sending) return;
    if (mode === "manual") {
      const { valid, invalid } = parseEmailList(emailsText);
      if (invalid.length) {
        setEmailError(
          `Invalid email${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
        );
        return;
      }
      if (!valid.length) {
        setEmailError("Please enter at least one email address");
        return;
      }
      setEmailError("");
      await onSend(valid);
      return;
    }
    const memberEmails = members.map((m) => m.email).filter(Boolean);
    if (!memberEmails.length) return;
    await onSend(memberEmails);
  };

  const tid = (base) => `${base}${testIdSuffix}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-4 py-4">
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v);
              setEmailError("");
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger
                value="manual"
                className="flex-1"
                data-testid={tid("tab-manual-email")}
              >
                <Mail className="w-4 h-4 mr-2" />
                Enter Email
              </TabsTrigger>
              <TabsTrigger
                value="member"
                className="flex-1"
                data-testid={tid("tab-member-lookup")}
              >
                <Search className="w-4 h-4 mr-2" />
                Find Member
              </TabsTrigger>
            </TabsList>

            <TabsContent value="manual" className="mt-4">
              <div className="space-y-2">
                <Label htmlFor={tid("test-email")}>Email Address(es)</Label>
                <Input
                  id={tid("test-email")}
                  type="text"
                  value={emailsText}
                  onChange={(e) => {
                    setEmailsText(e.target.value);
                    if (emailError) setEmailError("");
                  }}
                  placeholder="reviewer1@example.com, reviewer2@example.com"
                  data-testid={tid("input-test-email")}
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple addresses with commas to send the test to
                  several reviewers.
                </p>
                {emailError && (
                  <p
                    className="text-sm text-destructive"
                    data-testid={tid("text-test-email-error")}
                  >
                    {emailError}
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="member" className="mt-4">
              <div className="space-y-2">
                <Label htmlFor={tid("member-search")}>Search Member</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id={tid("member-search")}
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="pl-9"
                    data-testid={tid("input-member-search")}
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  Add multiple members by selecting more than one from the
                  search results.
                </p>

                {searchResults.length > 0 && (
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {searchResults
                      .filter(
                        (m) =>
                          !members.some(
                            (sel) =>
                              (sel.email || "").toLowerCase() ===
                              (m.email || "").toLowerCase()
                          )
                      )
                      .map((member) => (
                        <button
                          key={member.id}
                          type="button"
                          onClick={() => addMember(member)}
                          className="w-full text-left px-3 py-2 hover-elevate flex items-center gap-2 border-b last:border-b-0"
                          data-testid={tid(`member-result-${member.id}`)}
                        >
                          <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">
                              {member.first_name} {member.last_name}
                            </div>
                            <div className="text-sm text-muted-foreground truncate">
                              {member.email}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                )}

                {searchQuery.length >= 2 &&
                  searchResults.length === 0 &&
                  !searching && (
                    <p className="text-sm text-muted-foreground">
                      No members found
                    </p>
                  )}

                {members.length > 0 && (
                  <div className="space-y-1.5 pt-2">
                    <Label className="text-xs text-muted-foreground">
                      Selected ({members.length})
                    </Label>
                    <div className="space-y-1.5">
                      {members.map((member) => (
                        <div
                          key={member.email}
                          className="bg-muted/50 border rounded-md p-2 flex items-center gap-2"
                          data-testid={tid(`selected-member-${member.id || member.email}`)}
                        >
                          <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm truncate">
                              {member.first_name} {member.last_name}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {member.email}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeMember(member.email)}
                            data-testid={tid(`button-remove-member-${member.id || member.email}`)}
                            aria-label={`Remove ${member.email}`}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid={tid("button-cancel-test-send")}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!canSend}
            data-testid={tid("button-confirm-test-send")}
          >
            {sending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <TestTube2 className="w-4 h-4 mr-2" />
            )}
            Send Test
            {recipients.length > 1 ? ` (${recipients.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
