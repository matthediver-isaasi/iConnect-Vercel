import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Plus, 
  Trash2, 
  X, 
  Save, 
  Settings2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff
} from "lucide-react";
import { CORE_FIELDS } from "@/hooks/useOrgDetailLayout";
import { OPERATORS } from "@/hooks/useOrgFieldVisibilityRules";
import { toast } from "sonner";

function generateId() {
  return `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export default function OrgFieldVisibilityRulesEditor({ 
  open, 
  onOpenChange,
  rulesConfig, 
  customFields = [],
  onSave, 
  onCancel,
  isSaving 
}) {
  const [editedRules, setEditedRules] = useState(null);
  const [collapsedRules, setCollapsedRules] = useState({});

  useEffect(() => {
    if (rulesConfig) {
      setEditedRules(JSON.parse(JSON.stringify(rulesConfig)));
    }
  }, [rulesConfig]);

  const toggleRuleCollapse = (ruleId) => {
    setCollapsedRules(prev => ({
      ...prev,
      [ruleId]: !prev[ruleId]
    }));
  };

  const getAllFields = () => {
    const coreFieldsList = CORE_FIELDS.map(cf => ({
      id: cf.id,
      label: cf.label,
      type: cf.type,
      fieldKey: cf.fieldKey,
      fieldType: 'core'
    }));
    
    const customFieldsList = customFields.map(cf => ({
      id: `custom:${cf.id}`,
      label: cf.label,
      type: cf.field_type,
      fieldId: cf.id,
      fieldType: 'custom',
      options: cf.options
    }));
    
    return [...coreFieldsList, ...customFieldsList];
  };

  const allFields = getAllFields();

  const getFieldLabel = (fieldId) => {
    const field = allFields.find(f => f.id === fieldId);
    return field?.label || fieldId;
  };

  const getFieldOptions = (fieldId) => {
    const field = allFields.find(f => f.id === fieldId);
    if (!field) return [];
    if (field.options) {
      return Array.isArray(field.options) ? field.options : [];
    }
    return [];
  };

  const addRule = () => {
    const newRule = {
      id: generateId(),
      logic: 'and',
      conditions: [
        { id: generateId(), field_id: '', operator: 'equals', value: '' }
      ],
      actions: [
        { id: generateId(), action_type: 'hide', target_field_id: '' }
      ]
    };
    
    setEditedRules(prev => ({
      ...prev,
      rules: [...(prev?.rules || []), newRule]
    }));
  };

  const removeRule = (ruleId) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.filter(r => r.id !== ruleId)
    }));
  };

  const updateRule = (ruleId, updates) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => r.id === ruleId ? { ...r, ...updates } : r)
    }));
  };

  const addCondition = (ruleId) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          conditions: [
            ...r.conditions,
            { id: generateId(), field_id: '', operator: 'equals', value: '' }
          ]
        };
      })
    }));
  };

  const removeCondition = (ruleId, conditionId) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          conditions: r.conditions.filter(c => c.id !== conditionId)
        };
      })
    }));
  };

  const updateCondition = (ruleId, conditionId, updates) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          conditions: r.conditions.map(c => c.id === conditionId ? { ...c, ...updates } : c)
        };
      })
    }));
  };

  const addAction = (ruleId) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          actions: [
            ...r.actions,
            { id: generateId(), action_type: 'hide', target_field_id: '' }
          ]
        };
      })
    }));
  };

  const removeAction = (ruleId, actionId) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          actions: r.actions.filter(a => a.id !== actionId)
        };
      })
    }));
  };

  const updateAction = (ruleId, actionId, updates) => {
    setEditedRules(prev => ({
      ...prev,
      rules: prev.rules.map(r => {
        if (r.id !== ruleId) return r;
        return {
          ...r,
          actions: r.actions.map(a => a.id === actionId ? { ...a, ...updates } : a)
        };
      })
    }));
  };

  const handleSave = async () => {
    try {
      await onSave(editedRules);
      toast.success('Visibility rules saved');
      onOpenChange(false);
    } catch (error) {
      toast.error('Failed to save rules');
    }
  };

  const handleCancel = () => {
    setEditedRules(JSON.parse(JSON.stringify(rulesConfig)));
    onCancel?.();
    onOpenChange(false);
  };

  if (!editedRules) return null;

  const rules = editedRules.rules || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5" />
            Field Visibility Rules
          </DialogTitle>
          <DialogDescription>
            Define rules to show or hide fields based on other field values
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
          <div className="space-y-4 py-4">
            {rules.length === 0 ? (
              <div className="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-lg">
                <Settings2 className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium">No visibility rules defined</p>
                <p className="text-xs mt-1 mb-4">Add rules to conditionally show or hide fields based on other field values</p>
                <Button onClick={addRule} size="sm" variant="outline" data-testid="button-add-first-rule">
                  <Plus className="w-4 h-4 mr-2" />
                  Add First Rule
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {rules.map((rule, ruleIndex) => {
                  const isCollapsed = collapsedRules[rule.id];
                  const conditions = rule.conditions || [];
                  const actions = rule.actions || [];
                  
                  return (
                    <div 
                      key={rule.id} 
                      className="border rounded-lg bg-slate-50/50"
                      data-testid={`rule-card-${ruleIndex}`}
                    >
                      <div 
                        className="flex items-center gap-2 p-3 border-b bg-white rounded-t-lg cursor-pointer"
                        onClick={() => toggleRuleCollapse(rule.id)}
                      >
                        {isCollapsed ? (
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        ) : (
                          <ChevronUp className="w-4 h-4 text-slate-400" />
                        )}
                        <Settings2 className="w-4 h-4 text-slate-600" />
                        <span className="flex-1 text-sm font-medium">
                          Rule #{ruleIndex + 1}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {conditions.length} condition{conditions.length !== 1 ? 's' : ''}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {actions.length} action{actions.length !== 1 ? 's' : ''}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-500 hover:text-red-700"
                          onClick={(e) => { e.stopPropagation(); removeRule(rule.id); }}
                          data-testid={`button-delete-rule-${ruleIndex}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>

                      {!isCollapsed && (
                        <div className="p-4 space-y-4">
                          {conditions.length > 1 && (
                            <div className="flex items-center gap-2">
                              <Label className="text-xs text-slate-600">Match:</Label>
                              <div className="flex gap-1">
                                <Button
                                  variant={rule.logic === 'and' ? 'default' : 'outline'}
                                  size="sm"
                                  className="h-7 text-xs px-3"
                                  onClick={() => updateRule(rule.id, { logic: 'and' })}
                                  data-testid={`button-logic-and-${ruleIndex}`}
                                >
                                  ALL (AND)
                                </Button>
                                <Button
                                  variant={rule.logic === 'or' ? 'default' : 'outline'}
                                  size="sm"
                                  className="h-7 text-xs px-3"
                                  onClick={() => updateRule(rule.id, { logic: 'or' })}
                                  data-testid={`button-logic-or-${ruleIndex}`}
                                >
                                  ANY (OR)
                                </Button>
                              </div>
                            </div>
                          )}

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-medium text-slate-600 uppercase tracking-wide">Conditions</Label>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs"
                                onClick={() => addCondition(rule.id)}
                                data-testid={`button-add-condition-${ruleIndex}`}
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add
                              </Button>
                            </div>
                            
                            {conditions.map((condition, condIndex) => {
                              const fieldOptions = getFieldOptions(condition.field_id);
                              const needsValueInput = !['is_empty', 'not_empty'].includes(condition.operator);
                              
                              return (
                                <div 
                                  key={condition.id} 
                                  className="flex items-center gap-2 p-2 bg-white rounded border"
                                  data-testid={`condition-row-${ruleIndex}-${condIndex}`}
                                >
                                  <span className="text-xs text-slate-400 w-8">
                                    {condIndex === 0 ? 'IF' : rule.logic === 'and' ? 'AND' : 'OR'}
                                  </span>
                                  
                                  <Select
                                    value={condition.field_id || undefined}
                                    onValueChange={(value) => updateCondition(rule.id, condition.id, { field_id: value, value: '' })}
                                  >
                                    <SelectTrigger className="h-8 w-40" data-testid={`select-condition-field-${ruleIndex}-${condIndex}`}>
                                      <SelectValue placeholder="Select field..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <div className="px-2 py-1 text-xs font-medium text-slate-500">Core Fields</div>
                                      {allFields.filter(f => f.fieldType === 'core').map(field => (
                                        <SelectItem key={field.id} value={field.id}>
                                          {field.label}
                                        </SelectItem>
                                      ))}
                                      {allFields.filter(f => f.fieldType === 'custom').length > 0 && (
                                        <>
                                          <div className="px-2 py-1 text-xs font-medium text-slate-500 mt-1">Custom Fields</div>
                                          {allFields.filter(f => f.fieldType === 'custom').map(field => (
                                            <SelectItem key={field.id} value={field.id}>
                                              {field.label}
                                            </SelectItem>
                                          ))}
                                        </>
                                      )}
                                    </SelectContent>
                                  </Select>

                                  <Select
                                    value={condition.operator || 'equals'}
                                    onValueChange={(value) => updateCondition(rule.id, condition.id, { operator: value })}
                                  >
                                    <SelectTrigger className="h-8 w-36" data-testid={`select-condition-operator-${ruleIndex}-${condIndex}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {OPERATORS.map(op => (
                                        <SelectItem key={op.value} value={op.value}>
                                          {op.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>

                                  {needsValueInput && (
                                    fieldOptions.length > 0 ? (
                                      <Select
                                        value={condition.value || undefined}
                                        onValueChange={(value) => updateCondition(rule.id, condition.id, { value })}
                                      >
                                        <SelectTrigger className="h-8 flex-1" data-testid={`select-condition-value-${ruleIndex}-${condIndex}`}>
                                          <SelectValue placeholder="Select value..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {fieldOptions.map((opt, optIdx) => {
                                            const optValue = typeof opt === 'string' ? opt : (opt.value || opt);
                                            const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || opt);
                                            return (
                                              <SelectItem key={optIdx} value={optValue}>
                                                {optLabel}
                                              </SelectItem>
                                            );
                                          })}
                                        </SelectContent>
                                      </Select>
                                    ) : (
                                      <Input
                                        value={condition.value || ''}
                                        onChange={(e) => updateCondition(rule.id, condition.id, { value: e.target.value })}
                                        placeholder="Enter value..."
                                        className="h-8 flex-1"
                                        data-testid={`input-condition-value-${ruleIndex}-${condIndex}`}
                                      />
                                    )
                                  )}

                                  {conditions.length > 1 && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-red-500 hover:text-red-700"
                                      onClick={() => removeCondition(rule.id, condition.id)}
                                      data-testid={`button-delete-condition-${ruleIndex}-${condIndex}`}
                                    >
                                      <X className="w-3 h-3" />
                                    </Button>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-medium text-slate-600 uppercase tracking-wide">Actions</Label>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs"
                                onClick={() => addAction(rule.id)}
                                data-testid={`button-add-action-${ruleIndex}`}
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add
                              </Button>
                            </div>
                            
                            {actions.map((action, actionIndex) => (
                              <div 
                                key={action.id} 
                                className="flex items-center gap-2 p-2 bg-white rounded border"
                                data-testid={`action-row-${ruleIndex}-${actionIndex}`}
                              >
                                <span className="text-xs text-slate-400 w-8">THEN</span>
                                
                                <Select
                                  value={action.action_type || 'hide'}
                                  onValueChange={(value) => updateAction(rule.id, action.id, { action_type: value })}
                                >
                                  <SelectTrigger className="h-8 w-28" data-testid={`select-action-type-${ruleIndex}-${actionIndex}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="hide">
                                      <span className="flex items-center gap-1">
                                        <EyeOff className="w-3 h-3" /> Hide
                                      </span>
                                    </SelectItem>
                                    <SelectItem value="show">
                                      <span className="flex items-center gap-1">
                                        <Eye className="w-3 h-3" /> Show
                                      </span>
                                    </SelectItem>
                                  </SelectContent>
                                </Select>

                                <Select
                                  value={action.target_field_id || undefined}
                                  onValueChange={(value) => updateAction(rule.id, action.id, { target_field_id: value })}
                                >
                                  <SelectTrigger className="h-8 flex-1" data-testid={`select-action-target-${ruleIndex}-${actionIndex}`}>
                                    <SelectValue placeholder="Select field to show/hide..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <div className="px-2 py-1 text-xs font-medium text-slate-500">Core Fields</div>
                                    {allFields.filter(f => f.fieldType === 'core').map(field => (
                                      <SelectItem key={field.id} value={field.id}>
                                        {field.label}
                                      </SelectItem>
                                    ))}
                                    {allFields.filter(f => f.fieldType === 'custom').length > 0 && (
                                      <>
                                        <div className="px-2 py-1 text-xs font-medium text-slate-500 mt-1">Custom Fields</div>
                                        {allFields.filter(f => f.fieldType === 'custom').map(field => (
                                          <SelectItem key={field.id} value={field.id}>
                                            {field.label}
                                          </SelectItem>
                                        ))}
                                      </>
                                    )}
                                  </SelectContent>
                                </Select>

                                {actions.length > 1 && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-red-500 hover:text-red-700"
                                    onClick={() => removeAction(rule.id, action.id)}
                                    data-testid={`button-delete-action-${ruleIndex}-${actionIndex}`}
                                  >
                                    <X className="w-3 h-3" />
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={addRule}
                  className="w-full"
                  data-testid="button-add-rule"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Rule
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-rules">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving} data-testid="button-save-rules">
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Rules
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
