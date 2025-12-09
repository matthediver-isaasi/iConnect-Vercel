import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import ReactQuill from "react-quill";

export function IEditTableElementEditor({ element, onChange }) {
  const content = element.content || { 
    rows: 2, 
    cols: 2, 
    cells: {}, 
    cellTypes: {}, 
    columnWidths: {},
    tableWidth: 'full',
    tableAlign: 'center',
    header: '',
    description: '',
    backgroundImage: '',
    backgroundColor: '#ffffff',
    sectionWidth: 'full'
  };
  const [uploadingCells, setUploadingCells] = useState({});

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateCell = (rowIndex, colIndex, value) => {
    const cellKey = `${rowIndex}-${colIndex}`;
    // Prevent unnecessary updates if value hasn't changed
    if (content.cells?.[cellKey] === value) return;
    
    const cells = { ...content.cells };
    cells[cellKey] = value;
    updateContent('cells', cells);
  };

  const updateCellType = (rowIndex, colIndex, type) => {
    const cellTypes = { ...content.cellTypes };
    cellTypes[`${rowIndex}-${colIndex}`] = type;
    updateContent('cellTypes', cellTypes);
  };

  const updateColumnWidth = (colIndex, width) => {
    const columnWidths = { ...content.columnWidths };
    columnWidths[colIndex] = parseFloat(width) || 0;
    updateContent('columnWidths', columnWidths);
  };

  const handleImageUpload = async (rowIndex, colIndex, file) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    const cellKey = `${rowIndex}-${colIndex}`;
    setUploadingCells({ ...uploadingCells, [cellKey]: true });

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateCell(rowIndex, colIndex, response.file_url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error('Upload failed: ' + error.message);
    } finally {
      setUploadingCells(prev => ({ ...prev, [cellKey]: false }));
    }
  };

  const updateRows = (newRows) => {
    const rows = Math.max(1, parseInt(newRows) || 1);
    updateContent('rows', rows);
  };

  const updateCols = (newCols) => {
    const cols = Math.max(1, parseInt(newCols) || 1);
    updateContent('cols', cols);
  };

  const rows = content.rows || 2;
  const cols = content.cols || 2;
  const cells = content.cells || {};
  const cellTypes = content.cellTypes || {};
  const columnWidths = content.columnWidths || {};
  const tableWidth = content.tableWidth || 'full';
  const tableAlign = content.tableAlign || 'center';

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., table-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-table-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <div>
        <Label htmlFor="header">Section Header</Label>
        <Input
          id="header"
          value={content.header || ''}
          onChange={(e) => updateContent('header', e.target.value)}
          placeholder="Optional header text"
        />
      </div>

      <div>
        <Label htmlFor="description">Section Description</Label>
        <Textarea
          id="description"
          value={content.description || ''}
          onChange={(e) => updateContent('description', e.target.value)}
          placeholder="Optional description text"
          rows={3}
        />
      </div>

      <div>
        <Label htmlFor="sectionWidth">Section Width</Label>
        <Select value={content.sectionWidth || 'full'} onValueChange={(value) => updateContent('sectionWidth', value)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">Full Width</SelectItem>
            <SelectItem value="contained">Contained (max-w-7xl)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="backgroundImage">Background Image URL</Label>
        <Input
          id="backgroundImage"
          value={content.backgroundImage || ''}
          onChange={(e) => updateContent('backgroundImage', e.target.value)}
          placeholder="Optional background image URL"
        />
      </div>

      <div>
        <Label htmlFor="backgroundColor">Background Color</Label>
        <div className="flex gap-2 items-center">
          <Input
            id="backgroundColor"
            type="color"
            value={content.backgroundColor || '#ffffff'}
            onChange={(e) => updateContent('backgroundColor', e.target.value)}
            className="w-20 h-10"
          />
          <Input
            type="text"
            value={content.backgroundColor || '#ffffff'}
            onChange={(e) => updateContent('backgroundColor', e.target.value)}
            placeholder="#ffffff"
          />
        </div>
      </div>

      <div className="border-t pt-4">
        <h3 className="font-semibold mb-4">Table Settings</h3>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="rows">Rows</Label>
          <Input
            id="rows"
            type="number"
            min="1"
            max="10"
            value={rows}
            onChange={(e) => updateRows(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="cols">Columns</Label>
          <Input
            id="cols"
            type="number"
            min="1"
            max="10"
            value={cols}
            onChange={(e) => updateCols(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="tableWidth">Table Width</Label>
        <Select value={tableWidth} onValueChange={(value) => updateContent('tableWidth', value)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">Full Width</SelectItem>
            <SelectItem value="half">Half Width</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {tableWidth === 'half' && (
        <div>
          <Label htmlFor="tableAlign">Table Alignment</Label>
          <Select value={tableAlign} onValueChange={(value) => updateContent('tableAlign', value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="center">Center</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="borderStyle">Border Style</Label>
        <Select value={content.borderStyle || 'solid'} onValueChange={(value) => updateContent('borderStyle', value)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="borderWidth">Border Width (px)</Label>
        <Input
          id="borderWidth"
          type="number"
          min="0"
          max="10"
          value={content.borderWidth || 1}
          onChange={(e) => updateContent('borderWidth', parseInt(e.target.value) || 0)}
        />
      </div>

      <div>
        <Label htmlFor="borderColor">Border Color</Label>
        <div className="flex gap-2 items-center">
          <Input
            id="borderColor"
            type="color"
            value={content.borderColor || '#e2e8f0'}
            onChange={(e) => updateContent('borderColor', e.target.value)}
            className="w-20 h-10"
          />
          <Input
            type="text"
            value={content.borderColor || '#e2e8f0'}
            onChange={(e) => updateContent('borderColor', e.target.value)}
            placeholder="#e2e8f0"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="headerBgColor">Header Cell Background</Label>
        <div className="flex gap-2 items-center">
          <Input
            id="headerBgColor"
            type="color"
            value={content.headerBgColor || '#f8fafc'}
            onChange={(e) => updateContent('headerBgColor', e.target.value)}
            className="w-20 h-10"
          />
          <Input
            type="text"
            value={content.headerBgColor || '#f8fafc'}
            onChange={(e) => updateContent('headerBgColor', e.target.value)}
            placeholder="#f8fafc"
          />
        </div>
      </div>

      <div className="border-t pt-4">
        <Label>Column Widths (%)</Label>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, colIndex) => (
            <div key={colIndex}>
              <Label className="text-xs">Col {colIndex + 1}</Label>
              <Input
                type="number"
                min="0"
                max="100"
                value={columnWidths[colIndex] || ''}
                onChange={(e) => updateColumnWidth(colIndex, e.target.value)}
                placeholder="Auto"
                className="text-xs h-8"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-1">Leave blank for auto width. Total should equal 100%.</p>
      </div>

      <div className="border-t pt-4">
        <Label>Table Preview</Label>
        <div className="mt-2 p-4 bg-slate-50 rounded-lg overflow-x-auto">
            <table className="w-full border-collapse" style={{ 
              borderColor: content.borderColor || '#e2e8f0',
              borderStyle: content.borderStyle || 'solid',
              borderWidth: `${content.borderWidth || 1}px`
            }}>
              <colgroup>
                {Array.from({ length: cols }).map((_, colIndex) => (
                  <col key={colIndex} style={{ width: columnWidths[colIndex] ? `${columnWidths[colIndex]}%` : 'auto' }} />
                ))}
              </colgroup>
              <tbody>
                {Array.from({ length: rows }).map((_, rowIndex) => (
                  <tr key={rowIndex}>
                    {Array.from({ length: cols }).map((_, colIndex) => {
                      const cellKey = `${rowIndex}-${colIndex}`;
                      const cellType = cellTypes[cellKey] || 'text';
                      const isHeader = cellType === 'header';
                      const CellTag = isHeader ? 'th' : 'td';
                      const cellContent = cells[cellKey] || '';

                      return (
                        <CellTag
                          key={colIndex}
                          className="p-2 text-xs"
                          style={{
                            border: content.borderStyle === 'none' ? 'none' : undefined,
                            borderColor: content.borderColor || '#e2e8f0',
                            borderStyle: content.borderStyle || 'solid',
                            borderWidth: `${content.borderWidth || 1}px`,
                            backgroundColor: isHeader ? (content.headerBgColor || '#f8fafc') : 'white',
                            fontWeight: isHeader ? '600' : '400',
                            textAlign: 'left'
                          }}
                        >
                        {cellType === 'image' ? (
                          cellContent ? (
                            <img src={cellContent} alt="Preview" className="w-full h-auto max-h-16 object-contain" />
                          ) : (
                            <span className="text-slate-400">No image</span>
                          )
                        ) : (
                          <div className="truncate">{cellContent || `${rowIndex + 1},${colIndex + 1}`}</div>
                        )}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border-t pt-4">
        <Label>Cell Configuration</Label>
        <div className="mt-2 space-y-4 max-h-96 overflow-y-auto">
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <div key={rowIndex} className="border border-slate-200 rounded-lg p-3">
              <div className="text-xs font-medium text-slate-600 mb-2">
                Row {rowIndex + 1}
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                {Array.from({ length: cols }).map((_, colIndex) => {
                  const cellKey = `${rowIndex}-${colIndex}`;
                  const cellType = cellTypes[cellKey] || 'text';
                  
                  return (
                    <div key={colIndex} className="space-y-2 p-2 bg-slate-50 rounded">
                      <Select
                        value={cellType}
                        onValueChange={(value) => updateCellType(rowIndex, colIndex, value)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Text</SelectItem>
                          <SelectItem value="header">Header</SelectItem>
                          <SelectItem value="image">Image</SelectItem>
                        </SelectContent>
                      </Select>
                      
                      {cellType === 'image' ? (
                        <div className="space-y-1">
                          <Label htmlFor={`upload-${cellKey}`} className="cursor-pointer w-full">
                            <div className={`flex items-center justify-center h-8 rounded-md text-white transition-colors ${
                              uploadingCells[cellKey] ? 'bg-slate-400' : 'bg-blue-600 hover:bg-blue-700'
                            }`}>
                              {uploadingCells[cellKey] ? (
                                <>
                                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                  <span className="text-xs">Uploading...</span>
                                </>
                              ) : (
                                <>
                                  <Upload className="w-3 h-3 mr-1" />
                                  <span className="text-xs">Upload Image</span>
                                </>
                              )}
                            </div>
                            <input
                              id={`upload-${cellKey}`}
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleImageUpload(rowIndex, colIndex, file);
                                e.target.value = '';
                              }}
                              className="hidden"
                              disabled={uploadingCells[cellKey]}
                            />
                          </Label>
                          {cells[cellKey] && (
                            <img src={cells[cellKey]} alt="Preview" className="w-full h-12 object-contain rounded bg-slate-100" />
                          )}
                        </div>
                      ) : (
                        <div className="text-xs" key={`quill-${cellKey}`}>
                          <ReactQuill
                            key={cellKey}
                            value={cells[cellKey] || ''}
                            onChange={(value) => updateCell(rowIndex, colIndex, value)}
                            placeholder={cellType === 'header' ? 'Header text' : 'Content'}
                            theme="snow"
                            modules={{
                              toolbar: [
                                ['bold', 'italic', 'underline'],
                                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                                ['link'],
                                ['clean']
                              ]
                            }}
                            className="bg-white rounded"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function IEditTableElementRenderer({ element }) {
  const content = element.content || { rows: 2, cols: 2, cells: {}, cellTypes: {}, columnWidths: {}, tableWidth: 'full', tableAlign: 'center' };
  const rows = content.rows || 2;
  const cols = content.cols || 2;
  const cells = content.cells || {};
  const cellTypes = content.cellTypes || {};
  const columnWidths = content.columnWidths || {};
  const borderColor = content.borderColor || '#e2e8f0';
  const borderStyle = content.borderStyle || 'solid';
  const borderWidth = content.borderWidth || 1;
  const headerBgColor = content.headerBgColor || '#f8fafc';
  const tableWidth = content.tableWidth || 'full';
  const tableAlign = content.tableAlign || 'center';
  const header = content.header || '';
  const description = content.description || '';
  const backgroundImage = content.backgroundImage || '';
  const backgroundColor = content.backgroundColor || '#ffffff';
  const sectionWidth = content.sectionWidth || 'full';
  const anchor = content.anchor || '';

  const alignmentClass = {
    left: 'mr-auto',
    center: 'mx-auto',
    right: 'ml-auto'
  }[tableAlign] || 'mx-auto';

  const widthClass = tableWidth === 'half' ? 'w-1/2' : 'w-full';
  const containerClass = sectionWidth === 'contained' ? 'max-w-7xl mx-auto px-4' : 'w-full px-4';

  const sectionStyle = {
    backgroundColor,
    ...(backgroundImage && {
      backgroundImage: `url(${backgroundImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    })
  };

  // For full-width sections, break out of container constraints
  const wrapperClass = sectionWidth === 'full' 
    ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] py-8'
    : 'w-full py-8';

  return (
    <div id={anchor || undefined} className={wrapperClass} style={sectionStyle}>
      <div className={containerClass}>
        {(header || description) && (
          <div className="mb-8 text-center">
            {header && <h2 className="text-3xl font-bold text-slate-900 mb-3">{header}</h2>}
            {description && <p className="text-lg text-slate-600 max-w-3xl mx-auto">{description}</p>}
          </div>
        )}
        <div className={`overflow-x-auto ${widthClass} ${alignmentClass}`}>
        <table className="w-full border-collapse" style={{ 
          borderColor,
          borderStyle,
          borderWidth: `${borderWidth}px`
        }}>
          <colgroup>
            {Array.from({ length: cols }).map((_, colIndex) => (
              <col key={colIndex} style={{ width: columnWidths[colIndex] ? `${columnWidths[colIndex]}%` : 'auto' }} />
            ))}
          </colgroup>
          <tbody>
            {Array.from({ length: rows }).map((_, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: cols }).map((_, colIndex) => {
                  const cellKey = `${rowIndex}-${colIndex}`;
                  const cellContent = cells[cellKey] || '';
                  const cellType = cellTypes[cellKey] || 'text';
                  const isHeader = cellType === 'header';
                  const CellTag = isHeader ? 'th' : 'td';

                  return (
                    <CellTag
                      key={colIndex}
                      className="p-4"
                      style={{
                        border: borderStyle === 'none' ? 'none' : undefined,
                        borderColor,
                        borderStyle,
                        borderWidth: `${borderWidth}px`,
                        backgroundColor: isHeader ? headerBgColor : 'white',
                        fontWeight: isHeader ? '600' : '400',
                        textAlign: 'left'
                      }}
                    >
                      {cellType === 'image' ? (
                        cellContent ? (
                          <img 
                            src={cellContent} 
                            alt="Cell content" 
                            className="w-full h-auto object-contain"
                            style={{ maxHeight: '150px' }}
                          />
                        ) : (
                          <div className="text-slate-400 text-sm">No image</div>
                        )
                      ) : (
                        <div 
                          className="text-slate-700 prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: cellContent }}
                        />
                      )}
                    </CellTag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}