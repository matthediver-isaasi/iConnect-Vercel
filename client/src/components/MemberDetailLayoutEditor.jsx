import { useState, useEffect } from "react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { 
  GripVertical, 
  Plus, 
  Trash2, 
  X, 
  Save, 
  Settings2,
  Loader2,
  LayoutGrid,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { MEMBER_CORE_FIELDS } from "@/hooks/useMemberDetailLayout";
import { CORE_FIELDS as ORG_CORE_FIELDS } from "@/hooks/useOrgDetailLayout";
import { toast } from "sonner";

function generateId() {
  return `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function getFieldColorClass(type) {
  switch (type) {
    case 'core':
      return 'bg-blue-100 text-blue-700 border border-blue-200';
    case 'custom':
      return 'bg-green-100 text-green-700 border border-green-200';
    case 'org_core':
    case 'org_custom':
      return 'bg-purple-100 text-purple-700 border border-purple-200';
    case 'relationship':
      return 'bg-amber-100 text-amber-800 border border-amber-200';
    default:
      return 'bg-slate-100 text-slate-700 border border-slate-200';
  }
}

export default function MemberDetailLayoutEditor({ 
  layout, 
  customFields = [], 
  orgCustomFields = [],
  relationshipPanels = [],
  onSave, 
  onCancel,
  isSaving 
}) {
  const [editedLayout, setEditedLayout] = useState(null);
  const [editingCardId, setEditingCardId] = useState(null);
  const [collapsedCards, setCollapsedCards] = useState({});
  
  const toggleCardCollapse = (cardId) => {
    setCollapsedCards(prev => ({
      ...prev,
      [cardId]: !prev[cardId]
    }));
  };

  useEffect(() => {
    if (layout) {
      setEditedLayout(JSON.parse(JSON.stringify(layout)));
    }
  }, [layout]);

  if (!editedLayout) return null;

  const allAvailableFields = [
    ...MEMBER_CORE_FIELDS.map(f => ({ ...f, type: 'core' })),
    ...customFields.map(cf => ({
      id: `custom:${cf.id}`,
      fieldId: cf.id,
      label: cf.label,
      type: 'custom',
      fieldType: cf.field_type
    })),
    ...ORG_CORE_FIELDS.map(f => ({
      id: `org_core:${f.fieldKey}`,
      fieldKey: f.fieldKey,
      label: f.label,
      type: 'org_core'
    })),
    ...orgCustomFields.map(cf => ({
      id: `org_custom:${cf.id}`,
      fieldId: cf.id,
      label: cf.label,
      type: 'org_custom',
      fieldType: cf.field_type
    })),
    ...relationshipPanels.map(({ definition, side }) => ({
      id: `relationship:${definition.id}:${side}`,
      definitionId: definition.id,
      side,
      label: side === 'source'
        ? (definition.source_label || 'Related records')
        : (definition.target_label || 'Related records'),
      type: 'relationship'
    }))
  ];

  const assignedFieldIds = new Set();
  editedLayout.cards.forEach(card => {
    card.fields.forEach(f => assignedFieldIds.add(f.id));
  });

  const unassignedFields = allAvailableFields.filter(f => !assignedFieldIds.has(f.id));

  const parseDroppableId = (droppableId) => {
    if (droppableId === 'unassigned') return { type: 'unassigned' };
    const [cardId, colStr] = droppableId.split(':col:');
    return { type: 'column', cardId, columnIndex: parseInt(colStr, 10) };
  };

  const getFieldsInColumn = (card, columnIndex) => {
    return card.fields.filter(f => f.columnIndex === columnIndex);
  };

  const handleDragEnd = (result) => {
    const { source, destination, type, draggableId } = result;
    
    if (!destination) return;

    if (type === 'CARD') {
      const newCards = [...editedLayout.cards];
      const [removed] = newCards.splice(source.index, 1);
      newCards.splice(destination.index, 0, removed);
      setEditedLayout({ ...editedLayout, cards: newCards });
      return;
    }

    if (type === 'FIELD') {
      const sourceParsed = parseDroppableId(source.droppableId);
      const destParsed = parseDroppableId(destination.droppableId);
      
      const newCards = [...editedLayout.cards];
      
      if (sourceParsed.type === 'unassigned') {
        const field = unassignedFields[source.index];
        if (destParsed.type === 'column') {
          const destCardIndex = newCards.findIndex(c => c.id === destParsed.cardId);
          if (destCardIndex !== -1) {
            const destCard = newCards[destCardIndex];
            const colFields = getFieldsInColumn(destCard, destParsed.columnIndex);
            
            const newField = {
              id: field.id,
              type: field.type,
              columnIndex: destParsed.columnIndex,
              ...((field.type === 'core' || field.type === 'org_core')
                ? { fieldKey: field.fieldKey }
                : field.type === 'relationship'
                  ? { definitionId: field.definitionId, side: field.side }
                  : { fieldId: field.fieldId })
            };
            
            const insertAfterIndex = colFields[destination.index - 1]
              ? destCard.fields.findIndex(f => f.id === colFields[destination.index - 1].id) + 1
              : destCard.fields.findIndex(f => f.columnIndex === destParsed.columnIndex);
            
            const insertAt = insertAfterIndex === -1 ? destCard.fields.length : insertAfterIndex;
            const updatedFields = [...destCard.fields];
            updatedFields.splice(insertAt < 0 ? 0 : insertAt, 0, newField);
            newCards[destCardIndex] = { ...destCard, fields: updatedFields };
          }
        }
      } else if (destParsed.type === 'unassigned') {
        const sourceCardIndex = newCards.findIndex(c => c.id === sourceParsed.cardId);
        if (sourceCardIndex !== -1) {
          const sourceCard = newCards[sourceCardIndex];
          const fieldToRemove = sourceCard.fields.find(f => f.id === draggableId);
          if (fieldToRemove) {
            newCards[sourceCardIndex] = {
              ...sourceCard,
              fields: sourceCard.fields.filter(f => f.id !== draggableId)
            };
          }
        }
      } else {
        const sourceCardIndex = newCards.findIndex(c => c.id === sourceParsed.cardId);
        const destCardIndex = newCards.findIndex(c => c.id === destParsed.cardId);
        
        if (sourceCardIndex !== -1) {
          const sourceCard = newCards[sourceCardIndex];
          const fieldToMove = sourceCard.fields.find(f => f.id === draggableId);
          
          if (fieldToMove) {
            newCards[sourceCardIndex] = {
              ...sourceCard,
              fields: sourceCard.fields.filter(f => f.id !== draggableId)
            };
            
            if (destCardIndex !== -1) {
              const destCard = newCards[destCardIndex];
              const colFields = getFieldsInColumn(destCard, destParsed.columnIndex);
              
              const updatedField = { ...fieldToMove, columnIndex: destParsed.columnIndex };
              
              let insertAt = 0;
              if (destination.index > 0 && colFields[destination.index - 1]) {
                const prevFieldId = colFields[destination.index - 1].id;
                insertAt = destCard.fields.findIndex(f => f.id === prevFieldId) + 1;
              } else {
                const firstInCol = destCard.fields.findIndex(f => f.columnIndex === destParsed.columnIndex);
                insertAt = firstInCol === -1 ? destCard.fields.length : firstInCol;
              }
              
              const updatedFields = [...newCards[destCardIndex].fields];
              updatedFields.splice(insertAt, 0, updatedField);
              newCards[destCardIndex] = { ...newCards[destCardIndex], fields: updatedFields };
            }
          }
        }
      }
      
      setEditedLayout({ ...editedLayout, cards: newCards });
    }
  };

  const addCard = () => {
    const newCard = {
      id: generateId(),
      title: 'New Card',
      columns: 2,
      fields: []
    };
    setEditedLayout({
      ...editedLayout,
      cards: [...editedLayout.cards, newCard]
    });
    setEditingCardId(newCard.id);
  };

  const deleteCard = (cardId) => {
    setEditedLayout({
      ...editedLayout,
      cards: editedLayout.cards.filter(c => c.id !== cardId)
    });
  };

  const updateCard = (cardId, updates) => {
    setEditedLayout({
      ...editedLayout,
      cards: editedLayout.cards.map(c => 
        c.id === cardId ? { ...c, ...updates } : c
      )
    });
  };

  const getFieldLabel = (field) => {
    if (field.type === 'relationship') {
      const panel = relationshipPanels.find(({ definition, side }) =>
        String(definition.id) === String(field.definitionId) && side === field.side
      );
      return panel
        ? (panel.side === 'source'
          ? panel.definition.source_label
          : panel.definition.target_label) || 'Related records'
        : 'Unavailable relationship';
    }
    if (field.type === 'core') {
      const coreField = MEMBER_CORE_FIELDS.find(f => f.fieldKey === field.fieldKey);
      return coreField?.label || field.fieldKey;
    }
    if (field.type === 'org_core') {
      const orgCoreField = ORG_CORE_FIELDS.find(f => f.fieldKey === field.fieldKey);
      return orgCoreField?.label || field.fieldKey;
    }
    if (field.type === 'org_custom') {
      const ocf = orgCustomFields.find(cf => cf.id === field.fieldId);
      return ocf?.label || 'Unknown Field';
    }
    const customField = customFields.find(cf => cf.id === field.fieldId);
    return customField?.label || 'Unknown Field';
  };

  const handleSave = async () => {
    try {
      await onSave(editedLayout);
      toast.success('Layout saved successfully');
    } catch (error) {
      toast.error('Failed to save layout');
      console.error('Layout save error:', error);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Customize Member Layout</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel} data-testid="button-cancel-member-layout">
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving} data-testid="button-save-member-layout">
              {isSaving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Layout
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="flex gap-4">
              <div className="flex-1 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-slate-700">Cards</h3>
                  <Button size="sm" variant="outline" onClick={addCard} data-testid="button-add-member-card">
                    <Plus className="w-4 h-4 mr-1" />
                    Add Card
                  </Button>
                </div>

                <Droppable droppableId="cards" type="CARD">
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className="space-y-3"
                    >
                      {editedLayout.cards.map((card, cardIndex) => (
                        <Draggable key={card.id} draggableId={card.id} index={cardIndex}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={`bg-slate-50 rounded-lg border ${snapshot.isDragging ? 'shadow-lg' : ''}`}
                            >
                              <div className="flex items-center gap-2 p-3 border-b bg-white rounded-t-lg">
                                <div {...provided.dragHandleProps} className="cursor-grab">
                                  <GripVertical className="w-4 h-4 text-slate-400" />
                                </div>
                                
                                {editingCardId === card.id ? (
                                  <div className="flex-1 flex items-center gap-2">
                                    <Input
                                      value={card.title}
                                      onChange={(e) => updateCard(card.id, { title: e.target.value })}
                                      className="h-8 text-sm"
                                      placeholder="Card title"
                                      data-testid={`input-member-card-title-${card.id}`}
                                    />
                                    <Select 
                                      value={String(card.columns)} 
                                      onValueChange={(v) => updateCard(card.id, { columns: parseInt(v) })}
                                    >
                                      <SelectTrigger className="w-24 h-8" data-testid={`select-member-columns-${card.id}`}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="1">1 col</SelectItem>
                                        <SelectItem value="2">2 cols</SelectItem>
                                        <SelectItem value="3">3 cols</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <Button 
                                      size="sm" 
                                      variant="ghost" 
                                      onClick={() => setEditingCardId(null)}
                                    >
                                      Done
                                    </Button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => toggleCardCollapse(card.id)}
                                      className="flex items-center gap-1 flex-1 text-left"
                                      data-testid={`button-toggle-member-card-${card.id}`}
                                    >
                                      {collapsedCards[card.id] ? (
                                        <ChevronDown className="w-4 h-4 text-slate-400" />
                                      ) : (
                                        <ChevronUp className="w-4 h-4 text-slate-400" />
                                      )}
                                      <span className="font-medium text-sm">{card.title}</span>
                                    </button>
                                    <Badge variant="secondary" className="text-xs">
                                      {card.columns} {card.columns === 1 ? 'column' : 'columns'}
                                    </Badge>
                                    <Button 
                                      size="icon" 
                                      variant="ghost" 
                                      onClick={() => setEditingCardId(card.id)}
                                      data-testid={`button-edit-member-card-${card.id}`}
                                    >
                                      <Settings2 className="w-3.5 h-3.5" />
                                    </Button>
                                    <Button 
                                      size="icon" 
                                      variant="ghost" 
                                      className="text-red-500 hover:text-red-700"
                                      onClick={() => deleteCard(card.id)}
                                      data-testid={`button-delete-member-card-${card.id}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>

                              {!collapsedCards[card.id] && (
                                <div className={`grid gap-2 p-3 ${
                                  card.columns === 1 ? 'grid-cols-1' : 
                                  card.columns === 2 ? 'grid-cols-2' : 'grid-cols-3'
                                }`}>
                                  {Array.from({ length: card.columns }).map((_, colIndex) => {
                                    const colFields = card.fields.filter(f => f.columnIndex === colIndex);
                                    return (
                                      <Droppable 
                                        key={colIndex} 
                                        droppableId={`${card.id}:col:${colIndex}`} 
                                        type="FIELD"
                                      >
                                        {(provided, snapshot) => (
                                          <div
                                            ref={provided.innerRef}
                                            {...provided.droppableProps}
                                            className={`
                                              space-y-2 p-2 rounded-md min-h-[60px]
                                              ${snapshot.isDraggingOver ? 'bg-blue-100 border-blue-300' : 'bg-slate-100/50'}
                                              ${colIndex < card.columns - 1 ? 'border-r border-slate-200' : ''}
                                              border border-dashed border-slate-300
                                            `}
                                          >
                                            <div className="text-xs text-slate-400 font-medium text-center pb-1 border-b border-slate-200">
                                              Column {colIndex + 1}
                                            </div>
                                            {colFields.length === 0 ? (
                                              <p className="text-xs text-slate-400 text-center py-2">
                                                Drop here
                                              </p>
                                            ) : (
                                              colFields.map((field, fieldIndex) => (
                                                <Draggable 
                                                  key={field.id} 
                                                  draggableId={field.id} 
                                                  index={fieldIndex}
                                                >
                                                  {(provided, snapshot) => (
                                                    <div
                                                      ref={provided.innerRef}
                                                      {...provided.draggableProps}
                                                      {...provided.dragHandleProps}
                                                      className={`
                                                        px-3 py-2 rounded-md text-sm flex items-center gap-2
                                                        ${getFieldColorClass(field.type)}
                                                        ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-400' : ''}
                                                        cursor-grab hover:shadow-sm transition-shadow
                                                      `}
                                                    >
                                                      <GripVertical className="w-3 h-3 opacity-50 flex-shrink-0" />
                                                      <span className="truncate">{getFieldLabel(field)}</span>
                                                    </div>
                                                  )}
                                                </Draggable>
                                              ))
                                            )}
                                            {provided.placeholder}
                                          </div>
                                        )}
                                      </Droppable>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>

              <div className="w-64 flex-shrink-0">
                <h3 className="font-medium text-slate-700 mb-3">Available Fields</h3>
                <Droppable droppableId="unassigned" type="FIELD">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`
                        border rounded-lg p-3 min-h-[200px]
                        ${snapshot.isDraggingOver ? 'bg-slate-100 border-slate-300' : 'bg-slate-50'}
                      `}
                    >
                      {unassignedFields.length === 0 ? (
                        <p className="text-xs text-slate-400 text-center py-4">
                          All fields assigned
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {(() => {
                            const memberGroup = unassignedFields.filter(f => f.type === 'core' || f.type === 'custom');
                            const orgGroup = unassignedFields.filter(f => f.type === 'org_core' || f.type === 'org_custom');
                            const relationshipGroup = unassignedFields.filter(f => f.type === 'relationship');
                            const renderDraggable = (field) => (
                              <Draggable
                                key={field.id}
                                draggableId={field.id}
                                index={unassignedFields.indexOf(field)}
                              >
                                {(provided, snapshot) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    {...provided.dragHandleProps}
                                    className={`
                                      px-3 py-2 rounded-md text-sm flex items-center gap-2
                                      ${getFieldColorClass(field.type)}
                                      ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-400' : ''}
                                      cursor-grab hover:shadow-sm transition-shadow
                                    `}
                                  >
                                    <GripVertical className="w-3 h-3 opacity-50 flex-shrink-0" />
                                    <span className="truncate">{field.label}</span>
                                  </div>
                                )}
                              </Draggable>
                            );
                            return (
                              <>
                                {memberGroup.length > 0 && (
                                  <>
                                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide px-1">Member</p>
                                    {memberGroup.map(renderDraggable)}
                                  </>
                                )}
                                {orgGroup.length > 0 && (
                                  <>
                                    <p className="text-xs font-medium text-purple-600 uppercase tracking-wide px-1 pt-2">Organisation</p>
                                    {orgGroup.map(renderDraggable)}
                                  </>
                                )}
                                {relationshipGroup.length > 0 && (
                                  <>
                                    <p className="text-xs font-medium text-amber-700 uppercase tracking-wide px-1 pt-2">Relationships</p>
                                    {relationshipGroup.map(renderDraggable)}
                                  </>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>

                <div className="mt-4 p-3 bg-slate-100 rounded-lg text-xs text-slate-600">
                  <p className="font-medium mb-1">Tips:</p>
                  <ul className="space-y-1 list-disc list-inside">
                    <li>Drag cards to reorder</li>
                    <li>Drag fields between cards</li>
                    <li>Click settings to edit card</li>
                    <li>Blue = member core fields</li>
                    <li>Green = member custom fields</li>
                    <li>Purple = linked organisation fields</li>
                    <li>Amber = Data Studio relationships</li>
                  </ul>
                </div>
              </div>
            </div>
          </DragDropContext>
        </div>
      </div>
    </div>
  );
}
