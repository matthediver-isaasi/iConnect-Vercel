import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  BarChart3,
  Plus,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronUp,
  Loader2,
  Users,
  ListChecks,
  AlertCircle,
  CheckCircle2
} from "lucide-react";
import { toast } from "sonner";

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

function transformPollResults(resultsData) {
  const rawEntries = resultsData?.questions || [];

  if (rawEntries.length === 0) return [];

  const isParticipantCentric = rawEntries[0]?.question_details?.some(
    d => d.question || d.polling_id
  );

  if (isParticipantCentric) {
    const questionMap = {};

    rawEntries.forEach(participant => {
      const participantName = participant.name || participant.first_name || 'Anonymous';
      const participantEmail = participant.email || '';

      (participant.question_details || []).forEach(detail => {
        const questionText = detail.question || 'Untitled Question';
        const pollingId = detail.polling_id || 'default';
        const key = `${pollingId}::${questionText}`;

        if (!questionMap[key]) {
          questionMap[key] = {
            pollingId,
            questionText,
            responses: []
          };
        }

        questionMap[key].responses.push({
          name: participantName,
          email: participantEmail,
          answer: detail.answer || '',
          date_time: detail.date_time || ''
        });
      });
    });

    const pollGroups = {};
    Object.values(questionMap).forEach(q => {
      const pollKey = q.pollingId;
      if (!pollGroups[pollKey]) {
        pollGroups[pollKey] = [];
      }
      pollGroups[pollKey].push(q);
    });

    return Object.entries(pollGroups).map(([pollId, questions]) => ({
      pollTitle: `Poll ${pollId === 'default' ? '' : pollId}`.trim(),
      questions: questions.map(q => ({
        questionText: q.questionText,
        responses: q.responses
      }))
    }));
  }

  return rawEntries.map(q => ({
    pollTitle: q.name || q.title || 'Untitled Poll',
    questions: [{
      questionText: q.name || q.title || q.question || 'Untitled Question',
      responses: (q.question_details || []).map(d => ({
        name: d.name || d.user_name || 'Anonymous',
        email: d.email || d.user_email || '',
        answer: d.answer || d.value || '',
        date_time: d.date_time || d.polling_time || ''
      }))
    }]
  }));
}

function PollResultsView({ zoomId, type }) {
  const { data: resultsData, isLoading, error } = useQuery({
    queryKey: ['zoom-poll-results', zoomId, type],
    queryFn: () => apiRequest(`/api/zoom/polls/${zoomId}?type=${type}&action=results`),
    retry: 1
  });

  const [expandedQuestions, setExpandedQuestions] = useState({});

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8" data-testid="loading-poll-results">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-2 text-slate-600">Loading poll results...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-amber-700 bg-amber-50 rounded-lg" data-testid="error-poll-results">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        <span>Unable to load poll results. The meeting may not have ended yet, or polls were not used.</span>
      </div>
    );
  }

  const polls = transformPollResults(resultsData);

  if (polls.length === 0) {
    return (
      <div className="text-center p-8 text-slate-500" data-testid="empty-poll-results">
        <BarChart3 className="h-10 w-10 mx-auto mb-3 text-slate-300" />
        <p>No poll results available yet.</p>
        <p className="text-sm mt-1">Results will appear here after the meeting ends and polls have been conducted.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="poll-results-container">
      {polls.map((poll, pollIndex) => (
        <div key={pollIndex} className="border border-slate-200 rounded-lg p-4">
          <h4 className="font-medium text-slate-900 mb-3" data-testid={`text-poll-title-${pollIndex}`}>{poll.pollTitle}</h4>
          {poll.questions.map((question, qIndex) => {
            const questionKey = `${pollIndex}-${qIndex}`;
            const answerCounts = {};
            let totalResponses = question.responses.length;

            question.responses.forEach(r => {
              const rawAnswer = r.answer || 'No answer';
              const answers = rawAnswer.includes(';') ? rawAnswer.split(';').map(a => a.trim()) : [rawAnswer];
              answers.forEach(answer => {
                answerCounts[answer] = (answerCounts[answer] || 0) + 1;
              });
            });

            return (
              <div key={qIndex} className="mb-4 last:mb-0">
                <p className="text-sm font-medium text-slate-800 mb-2" data-testid={`text-question-${pollIndex}-${qIndex}`}>
                  {question.questionText}
                </p>
                <div className="space-y-2 mb-2">
                  {Object.entries(answerCounts).map(([answer, count], aIndex) => {
                    const percentage = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
                    return (
                      <div key={aIndex} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-700" data-testid={`text-answer-${pollIndex}-${qIndex}-${aIndex}`}>{answer}</span>
                          <span className="text-slate-500 tabular-nums">{count} ({percentage}%)</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${percentage}%` }}
                            data-testid={`bar-answer-${pollIndex}-${qIndex}-${aIndex}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="text-xs text-slate-500 mb-1">
                  {totalResponses} {totalResponses === 1 ? 'response' : 'responses'}
                </div>

                {question.responses.length > 0 && (
                  <Collapsible
                    open={expandedQuestions[questionKey]}
                    onOpenChange={() => setExpandedQuestions(prev => ({ ...prev, [questionKey]: !prev[questionKey] }))}
                  >
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-xs" data-testid={`button-toggle-details-${pollIndex}-${qIndex}`}>
                        {expandedQuestions[questionKey] ? (
                          <><ChevronUp className="h-3 w-3 mr-1" />Hide individual responses</>
                        ) : (
                          <><ChevronDown className="h-3 w-3 mr-1" />Show individual responses</>
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 border border-slate-100 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-50">
                              <th className="text-left p-2 font-medium text-slate-600">Name</th>
                              <th className="text-left p-2 font-medium text-slate-600">Email</th>
                              <th className="text-left p-2 font-medium text-slate-600">Answer</th>
                              <th className="text-left p-2 font-medium text-slate-600">Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {question.responses.map((resp, dIndex) => (
                              <tr key={dIndex} className="border-t border-slate-100" data-testid={`row-response-${pollIndex}-${qIndex}-${dIndex}`}>
                                <td className="p-2 text-slate-700">{resp.name}</td>
                                <td className="p-2 text-slate-500">{resp.email || '-'}</td>
                                <td className="p-2 text-slate-700">{resp.answer || '-'}</td>
                                <td className="p-2 text-slate-500">{resp.date_time ? new Date(resp.date_time).toLocaleString() : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const createEmptyQuestion = () => ({
  _id: `q-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
  name: '',
  type: 'single',
  answers: ['', '']
});

function PollFormDialog({ open, onOpenChange, zoomId, type, editPoll, onSuccess }) {
  const [title, setTitle] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [questions, setQuestions] = useState([createEmptyQuestion()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (editPoll) {
        setTitle(editPoll.title || '');
        setAnonymous(editPoll.anonymous || false);
        setQuestions(
          editPoll.questions?.map(q => {
            const qType = q.type || 'single';
            const isText = qType === 'short_answer' || qType === 'long_answer';
            return {
              _id: `q-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
              name: q.name || '',
              type: qType,
              answers: isText ? [] : (q.answers || ['', ''])
            };
          }) || [createEmptyQuestion()]
        );
      } else {
        setTitle('');
        setAnonymous(false);
        setQuestions([createEmptyQuestion()]);
      }
    }
  }, [open, editPoll]);

  const resetForm = () => {
    setTitle('');
    setAnonymous(false);
    setQuestions([createEmptyQuestion()]);
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error('Poll title is required');
      return;
    }

    const validQuestions = questions.filter(q => q.name.trim());
    if (validQuestions.length === 0) {
      toast.error('At least one question is required');
      return;
    }

    for (const q of validQuestions) {
      if (!isTextType(q.type)) {
        const validAnswers = q.answers.filter(a => a.trim());
        if (validAnswers.length < 2) {
          toast.error(`Question "${q.name}" needs at least 2 answer options`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        anonymous,
        questions: validQuestions.map(q => ({
          name: q.name.trim(),
          type: q.type,
          answers: isTextType(q.type) ? [] : q.answers.filter(a => a.trim())
        }))
      };

      if (editPoll) {
        payload.pollId = editPoll.id;
        await apiRequest(`/api/zoom/polls/${zoomId}?type=${type}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        toast.success('Poll updated');
      } else {
        await apiRequest(`/api/zoom/polls/${zoomId}?type=${type}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        toast.success('Poll created');
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(error.message || 'Failed to save poll');
    } finally {
      setSaving(false);
    }
  };

  const addQuestion = () => {
    setQuestions([...questions, createEmptyQuestion()]);
  };

  const removeQuestion = (qId) => {
    if (questions.length <= 1) return;
    setQuestions(questions.filter(q => q._id !== qId));
  };

  const isTextType = (t) => t === 'short_answer' || t === 'long_answer';

  const updateQuestion = (qId, field, value) => {
    setQuestions(questions.map(q => {
      if (q._id !== qId) return q;
      if (field === 'type') {
        const wasText = isTextType(q.type);
        const nowText = isTextType(value);
        if (!wasText && nowText) {
          return { ...q, type: value, answers: [] };
        }
        if (wasText && !nowText) {
          return { ...q, type: value, answers: ['', ''] };
        }
        return { ...q, type: value };
      }
      return { ...q, [field]: value };
    }));
  };

  const addAnswer = (qId) => {
    setQuestions(questions.map(q =>
      q._id === qId ? { ...q, answers: [...q.answers, ''] } : q
    ));
  };

  const removeAnswer = (qId, aIndex) => {
    setQuestions(questions.map(q => {
      if (q._id !== qId || q.answers.length <= 2) return q;
      return { ...q, answers: q.answers.filter((_, i) => i !== aIndex) };
    }));
  };

  const updateAnswer = (qId, aIndex, value) => {
    setQuestions(questions.map(q => {
      if (q._id !== qId) return q;
      const newAnswers = [...q.answers];
      newAnswers[aIndex] = value;
      return { ...q, answers: newAnswers };
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-poll-form-title">{editPoll ? 'Edit Poll' : 'Create Poll'}</DialogTitle>
          <DialogDescription>
            {editPoll ? 'Update this poll for the Zoom event.' : 'Create a new poll for the Zoom event.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Poll Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Session Feedback"
              data-testid="input-poll-title"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Anonymous Polling</Label>
              <p className="text-xs text-slate-500">Participant identities will not be recorded</p>
            </div>
            <Switch
              checked={anonymous}
              onCheckedChange={setAnonymous}
              data-testid="switch-poll-anonymous"
            />
          </div>

          <Separator />

          <div className="space-y-4">
            <Label className="text-base font-medium">Questions</Label>
            {questions.map((question, qIndex) => (
              <div key={question._id} className="border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 space-y-2">
                    <Label className="text-sm">Question {qIndex + 1}</Label>
                    <Input
                      value={question.name}
                      onChange={(e) => updateQuestion(question._id, 'name', e.target.value)}
                      placeholder="Enter your question..."
                      data-testid={`input-poll-question-${qIndex}`}
                    />
                  </div>
                  {questions.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeQuestion(question._id)}
                      className="mt-6 text-red-500"
                      data-testid={`button-remove-question-${qIndex}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">Answer Type</Label>
                  <Select
                    value={question.type}
                    onValueChange={(value) => updateQuestion(question._id, 'type', value)}
                  >
                    <SelectTrigger data-testid={`select-question-type-${qIndex}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">Single Choice</SelectItem>
                      <SelectItem value="multiple">Multiple Choice</SelectItem>
                      <SelectItem value="short_answer">Short Answer</SelectItem>
                      <SelectItem value="long_answer">Long Answer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!isTextType(question.type) && (
                <div className="space-y-2">
                  <Label className="text-sm">Answer Options</Label>
                  {question.answers.map((answer, aIndex) => (
                    <div key={aIndex} className="flex items-center gap-2">
                      <Input
                        value={answer}
                        onChange={(e) => updateAnswer(question._id, aIndex, e.target.value)}
                        placeholder={`Option ${aIndex + 1}`}
                        data-testid={`input-poll-answer-${qIndex}-${aIndex}`}
                      />
                      {question.answers.length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeAnswer(question._id, aIndex)}
                          className="text-red-400 flex-shrink-0"
                          data-testid={`button-remove-answer-${qIndex}-${aIndex}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addAnswer(question._id)}
                    className="text-blue-600"
                    data-testid={`button-add-answer-${qIndex}`}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Option
                  </Button>
                </div>
                )}
                {isTextType(question.type) && (
                  <p className="text-sm text-muted-foreground" data-testid={`text-answer-hint-${qIndex}`}>
                    Attendees will type their response directly during the poll.
                  </p>
                )}
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addQuestion}
              className="border-dashed"
              data-testid="button-add-question"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Question
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            data-testid="button-cancel-poll"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            data-testid="button-save-poll"
          >
            {saving ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
            ) : (
              editPoll ? 'Update Poll' : 'Create Poll'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PollManagementView({ zoomId, type, readOnly = false }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editPoll, setEditPoll] = useState(null);
  const [deletingPollId, setDeletingPollId] = useState(null);

  const { data: pollsData, isLoading, error } = useQuery({
    queryKey: ['zoom-polls', zoomId, type],
    queryFn: () => apiRequest(`/api/zoom/polls/${zoomId}?type=${type}`),
    retry: 1
  });

  const deleteMutation = useMutation({
    mutationFn: (pollId) =>
      apiRequest(`/api/zoom/polls/${zoomId}?type=${type}&pollId=${pollId}`, {
        method: 'DELETE'
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zoom-polls', zoomId, type] });
      toast.success('Poll deleted');
      setDeletingPollId(null);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to delete poll');
      setDeletingPollId(null);
    }
  });

  const handleEdit = async (poll) => {
    try {
      const detail = await apiRequest(`/api/zoom/polls/${zoomId}?type=${type}&action=detail&pollId=${poll.id}`);
      setEditPoll(detail);
    } catch {
      setEditPoll(poll);
    }
    setFormOpen(true);
  };

  const handleCreate = () => {
    setEditPoll(null);
    setFormOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8" data-testid="loading-polls">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-2 text-slate-600">Loading polls...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-amber-700 bg-amber-50 rounded-lg" data-testid="error-polls">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        <span>Unable to load polls. The Zoom account may not support polls, or the {type} may not exist yet.</span>
      </div>
    );
  }

  const polls = pollsData?.polls || [];

  return (
    <div className="space-y-4" data-testid="poll-management-container">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">{polls.length} {polls.length === 1 ? 'poll' : 'polls'} configured</p>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            onClick={handleCreate}
            data-testid="button-create-poll"
          >
            <Plus className="h-4 w-4 mr-1" />
            Create Poll
          </Button>
        )}
      </div>

      {polls.length === 0 ? (
        <div className="text-center p-6 text-slate-500 border border-dashed border-slate-200 rounded-lg" data-testid="empty-polls">
          <ListChecks className="h-8 w-8 mx-auto mb-2 text-slate-300" />
          <p>No polls created yet.</p>
          <p className="text-sm mt-1">Create polls for participants to answer during the event.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {polls.map((poll, index) => (
            <div key={poll.id} className="border border-slate-200 rounded-lg p-4" data-testid={`card-poll-${index}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-slate-900" data-testid={`text-poll-name-${index}`}>{poll.title}</h4>
                    {poll.anonymous && (
                      <Badge variant="secondary" className="text-xs">Anonymous</Badge>
                    )}
                    {poll.status && (
                      <Badge
                        variant={poll.status === 'started' ? 'default' : 'outline'}
                        className="text-xs"
                      >
                        {poll.status}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-500 mt-1">
                    {poll.questions?.length || 0} {(poll.questions?.length || 0) === 1 ? 'question' : 'questions'}
                  </p>
                  {poll.questions?.map((q, qi) => (
                    <div key={qi} className="mt-2 text-sm">
                      <p className="text-slate-700 font-medium">{q.name}</p>
                      <div className="ml-4 text-slate-500">
                        {q.answers?.map((a, ai) => (
                          <p key={ai} className="flex items-center gap-1">
                            <span className="text-slate-300">{q.type === 'multiple' ? '[ ]' : '( )'}</span>
                            {a}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(poll)}
                      data-testid={`button-edit-poll-${index}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setDeletingPollId(poll.id);
                        deleteMutation.mutate(poll.id);
                      }}
                      disabled={deletingPollId === poll.id}
                      className="text-red-500"
                      data-testid={`button-delete-poll-${index}`}
                    >
                      {deletingPollId === poll.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <PollFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        zoomId={zoomId}
        type={type}
        editPoll={editPoll}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['zoom-polls', zoomId, type] })}
      />
    </div>
  );
}

export default function ZoomPolls({ zoomId, type = 'meeting', isPast = false, label }) {
  const [activeTab, setActiveTab] = useState(isPast ? 'results' : 'manage');

  if (!zoomId) {
    return null;
  }

  return (
    <Card className="border-slate-200 shadow-sm" data-testid="card-zoom-polls">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-indigo-600" />
          Zoom Polls
          {label && <span className="text-sm font-normal text-slate-500">- {label}</span>}
        </CardTitle>
        <CardDescription>
          {isPast
            ? 'View poll results from this completed event'
            : 'Manage polls for this upcoming event, or view results from past polls'
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-4">
          {isPast ? (
            <>
              <Button
                type="button"
                variant={activeTab === 'results' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('results')}
                data-testid="button-tab-poll-results"
              >
                <BarChart3 className="h-4 w-4 mr-1" />
                Poll Results
              </Button>
              <Button
                type="button"
                variant={activeTab === 'view' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('view')}
                data-testid="button-tab-view-polls"
              >
                <ListChecks className="h-4 w-4 mr-1" />
                View Polls
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant={activeTab === 'manage' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('manage')}
                data-testid="button-tab-manage-polls"
              >
                <ListChecks className="h-4 w-4 mr-1" />
                Manage Polls
              </Button>
              <Button
                type="button"
                variant={activeTab === 'results' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab('results')}
                data-testid="button-tab-poll-results"
              >
                <BarChart3 className="h-4 w-4 mr-1" />
                Poll Results
              </Button>
            </>
          )}
        </div>

        {activeTab === 'results' ? (
          <PollResultsView zoomId={zoomId} type={type} />
        ) : activeTab === 'view' ? (
          <PollManagementView zoomId={zoomId} type={type} readOnly />
        ) : (
          <PollManagementView zoomId={zoomId} type={type} />
        )}
      </CardContent>
    </Card>
  );
}
