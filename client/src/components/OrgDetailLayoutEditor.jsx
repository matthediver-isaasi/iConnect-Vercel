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
  LayoutGrid
} from "lucide-react";
import { CORE_FIELDS } from "@/hooks/useOrgDetailLayout";
import { toast } from "sonner";

function generateId() {
  return `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export default function OrgDetailLayoutEditor({ 
  layout, 
  customFields = [], 
  onSave, 
  onCancel,
  isSaving 
}) {
  const [editedLayout, setEditedLayout] = useState(null);
  const [editingCardId, setEditingCardId] = useState(null);

  useEffect(() => {
    if (layout) {
      setEditedLayout(JSON.parse(JSON.stringify(layout)));
    }
  }, [layout]);

  if (!editedLayout) return null;

  const allAvailableFields = [
    ...CORE_FIELDS.map(f => ({ ...f, type: 'core' })),
    ...customFields.map(cf => ({
      id: `custom:${cf.id}`,
      fieldId: cf.id,
      label: cf.label,
      type: 'custom',
      fieldType: cf.field_type
    }))
  ];

  const assignedFieldIds = new Set();
  editedLayout.cards.forEach(card => {
    card.fields.forEach(f => assignedFieldIds.add(f.id));
  });

  const unassignedFields = allAvailableFields.filter(f => !assignedFieldIds.has(f.id));

  const handleDragEnd = (result) => {
    const { source, destination, type } = result;
    
    if (!destination) return;

    if (type === 'CARD') {
      const newCards = [...editedLayout.cards];
      const [removed] = newCards.splice(source.index, 1);
      newCards.splice(destination.index, 0, removed);
      setEditedLayout({ ...editedLayout, cards: newCards });
      return;
    }

    if (type === 'FIELD') {
      const sourceCardIndex = editedLayout.cards.findIndex(c => c.id === source.droppableId);
      const destCardIndex = editedLayout.cards.findIndex(c => c.id === destination.droppableId);
      
      if (sourceCardIndex === -1) return;

      const newCards = [...editedLayout.cards];
      
      if (source.droppableId === 'unassigned') {
        const field = unassignedFields[source.index];
        if (destCardIndex !== -1) {
          const destFields = [...newCards[destCardIndex].fields];
          destFields.splice(destination.index, 0, {
            id: field.id,
            type: field.type,
            ...(field.type === 'core' ? { fieldKey: field.fieldKey } : { fieldId: field.fieldId })
          });
          newCards[destCardIndex] = { ...newCards[destCardIndex], fields: destFields };
        }
      } else if (destination.droppableId === 'unassigned') {
        const sourceFields = [...newCards[sourceCardIndex].fields];
        sourceFields.splice(source.index, 1);
        newCards[sourceCardIndex] = { ...newCards[sourceCardIndex], fields: sourceFields };
      } else {
        if (sourceCardIndex === destCardIndex) {
          const fields = [...newCards[sourceCardIndex].fields];
          const [removed] = fields.splice(source.index, 1);
          fields.splice(destination.index, 0, removed);
          newCards[sourceCardIndex] = { ...newCards[sourceCardIndex], fields };
        } else {
          const sourceFields = [...newCards[sourceCardIndex].fields];
          const destFields = [...newCards[destCardIndex].fields];
          const [removed] = sourceFields.splice(source.index, 1);
          destFields.splice(destination.index, 0, removed);
          newCards[sourceCardIndex] = { ...newCards[sourceCardIndex], fields: sourceFields };
          newCards[destCardIndex] = { ...newCards[destCardIndex], fields: destFields };
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
    if (field.type === 'core') {
      const coreField = CORE_FIELDS.find(f => f.fieldKey === field.fieldKey);
      return coreField?.label || field.fieldKey;
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
            <h2 className="text-lg font-semibold">Customize Organisation Layout</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel} data-testid="button-cancel-layout">
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving} data-testid="button-save-layout">
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
                  <Button size="sm" variant="outline" onClick={addCard} data-testid="button-add-card">
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
                                      data-testid={`input-card-title-${card.id}`}
                                    />
                                    <Select 
                                      value={String(card.columns)} 
                                      onValueChange={(v) => updateCard(card.id, { columns: parseInt(v) })}
                                    >
                                      <SelectTrigger className="w-24 h-8" data-testid={`select-columns-${card.id}`}>
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
                                    <span className="flex-1 font-medium text-sm">{card.title}</span>
                                    <Badge variant="secondary" className="text-xs">
                                      {card.columns} {card.columns === 1 ? 'column' : 'columns'}
                                    </Badge>
                                    <Button 
                                      size="icon" 
                                      variant="ghost" 
                                      className="h-7 w-7"
                                      onClick={() => setEditingCardId(card.id)}
                                      data-testid={`button-edit-card-${card.id}`}
                                    >
                                      <Settings2 className="w-3.5 h-3.5" />
                                    </Button>
                                    <Button 
                                      size="icon" 
                                      variant="ghost" 
                                      className="h-7 w-7 text-red-500 hover:text-red-700"
                                      onClick={() => deleteCard(card.id)}
                                      data-testid={`button-delete-card-${card.id}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>

                              <Droppable droppableId={card.id} type="FIELD">
                                {(provided, snapshot) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.droppableProps}
                                    className={`p-3 min-h-[80px] ${snapshot.isDraggingOver ? 'bg-blue-50' : ''}`}
                                  >
                                    {card.fields.length === 0 ? (
                                      <p className="text-xs text-slate-400 text-center py-4">
                                        Drag fields here
                                      </p>
                                    ) : (
                                      <div className={`grid gap-2 ${
                                        card.columns === 1 ? 'grid-cols-1' : 
                                        card.columns === 2 ? 'grid-cols-2' : 'grid-cols-3'
                                      }`}>
                                        {Array.from({ length: card.columns }).map((_, colIndex) => (
                                          <div 
                                            key={colIndex} 
                                            className={`
                                              space-y-2 p-2 rounded-md bg-slate-100/50
                                              ${colIndex < card.columns - 1 ? 'border-r border-slate-200' : ''}
                                            `}
                                          >
                                            <div className="text-xs text-slate-400 font-medium text-center pb-1 border-b border-slate-200">
                                              Column {colIndex + 1}
                                            </div>
                                            {card.fields
                                              .filter((_, idx) => idx % card.columns === colIndex)
                                              .map((field) => {
                                                const originalIndex = card.fields.findIndex(f => f.id === field.id);
                                                return (
                                                  <Draggable 
                                                    key={field.id} 
                                                    draggableId={field.id} 
                                                    index={originalIndex}
                                                  >
                                                    {(provided, snapshot) => (
                                                      <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        className={`
                                                          px-3 py-2 rounded-md text-sm flex items-center gap-2
                                                          ${field.type === 'core' ? 'bg-blue-100 text-blue-700 border border-blue-200' : 'bg-green-100 text-green-700 border border-green-200'}
                                                          ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-400' : ''}
                                                          cursor-grab hover:shadow-sm transition-shadow
                                                        `}
                                                      >
                                                        <GripVertical className="w-3 h-3 opacity-50 flex-shrink-0" />
                                                        <span className="truncate">{getFieldLabel(field)}</span>
                                                      </div>
                                                    )}
                                                  </Draggable>
                                                );
                                              })}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {provided.placeholder}
                                  </div>
                                )}
                              </Droppable>
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
                          {unassignedFields.map((field, index) => (
                            <Draggable 
                              key={field.id} 
                              draggableId={field.id} 
                              index={index}
                            >
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  className={`
                                    px-3 py-2 rounded-md text-sm flex items-center gap-2
                                    ${field.type === 'core' ? 'bg-blue-100 text-blue-700 border border-blue-200' : 'bg-green-100 text-green-700 border border-green-200'}
                                    ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-400' : ''}
                                    cursor-grab hover:shadow-sm transition-shadow
                                  `}
                                >
                                  <GripVertical className="w-3 h-3 opacity-50 flex-shrink-0" />
                                  <span className="truncate">{field.label}</span>
                                </div>
                              )}
                            </Draggable>
                          ))}
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
                    <li>Blue = core fields</li>
                    <li>Green = custom fields</li>
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
