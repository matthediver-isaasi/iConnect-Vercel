import React, { useId } from 'react';
import { Star } from 'lucide-react';

/**
 * Task #3330: public renderer for the survey Score field type.
 *
 * Accessible by construction: every rendering style except the slider is a
 * fieldset of real <input type="radio"> elements (visually hidden where a
 * custom visual is drawn on the label), so keyboard and screen-reader
 * behaviour comes from the browser. Meaning is never conveyed by colour
 * alone — each option always carries a visible number and/or text label.
 *
 * Value shape: { score: number } or { na: true } (see api/_lib/surveyScoring.js).
 */

export const SCORE_STYLE_LABELS = {
  stars: 'Stars',
  smileys: 'Smiley faces',
  numbers: 'Numbered buttons',
  descriptive: 'Descriptive buttons',
  slider: 'Slider',
  nps: 'NPS (0–10)'
};

export function getScoreFieldRange(field) {
  if ((field?.score_style || 'stars') === 'nps') return { min: 0, max: 10 };
  const min = Number.isFinite(Number(field?.score_min)) ? Math.trunc(Number(field.score_min)) : 1;
  const max = Number.isFinite(Number(field?.score_max)) ? Math.trunc(Number(field.score_max)) : 5;
  return { min, max };
}

const SMILEYS = ['😞', '🙁', '😐', '🙂', '😀'];

export default function ScoreField({ field, value, onChange, disabled = false, questionNumber = null }) {
  const groupId = useId();
  const style = field.score_style || 'stars';
  const { min, max } = getScoreFieldRange(field);
  const values = [];
  for (let v = min; v <= max && values.length <= 100; v++) values.push(v);
  const current = value && typeof value === 'object' ? value : {};
  const selected = current.na === true ? 'na' : (Number.isInteger(current.score) ? current.score : null);
  const perValueLabels = field.score_labels?.values || {};
  const lowLabel = field.score_labels?.low || '';
  const highLabel = field.score_labels?.high || '';

  const pick = (v) => {
    if (disabled) return;
    onChange(v === 'na' ? { na: true } : { score: v });
  };

  const optionAria = (v) => {
    const parts = [String(v)];
    if (perValueLabels[String(v)]) parts.push(perValueLabels[String(v)]);
    else if (v === min && lowLabel) parts.push(lowLabel);
    else if (v === max && highLabel) parts.push(highLabel);
    return parts.join(' — ');
  };

  const radio = (v, labelContent, extraClass = '') => {
    const isSelected = selected === v;
    return (
      <label
        key={String(v)}
        className={`relative flex flex-col items-center gap-1 cursor-pointer select-none ${disabled ? 'opacity-60 cursor-not-allowed' : ''} ${extraClass}`}
        data-testid={`score-option-${field.id}-${v}`}
      >
        <input
          type="radio"
          name={`score-${groupId}`}
          className="sr-only peer"
          checked={isSelected}
          onChange={() => pick(v)}
          disabled={disabled}
          aria-label={v === 'na' ? (field.na_label || 'Not applicable') : optionAria(v)}
        />
        {labelContent(isSelected)}
      </label>
    );
  };

  const renderOptions = () => {
    if (style === 'stars') {
      return (
        <div className="flex items-end gap-1 flex-wrap">
          {values.map((v, i) =>
            radio(v, (isSelected) => (
              <>
                <Star
                  className={`w-8 h-8 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 rounded ${selected !== null && selected !== 'na' && v <= selected ? 'text-amber-400 fill-amber-400' : 'text-slate-300'}`}
                  aria-hidden="true"
                />
                <span className={`text-xs ${isSelected ? 'font-semibold text-slate-800' : 'text-slate-500'}`}>{v}</span>
              </>
            ))
          )}
        </div>
      );
    }
    if (style === 'smileys') {
      return (
        <div className="flex items-end gap-2 flex-wrap">
          {values.map((v, i) =>
            radio(v, (isSelected) => (
              <>
                <span
                  className={`text-3xl rounded-full transition-transform peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 ${isSelected ? 'scale-125' : 'grayscale opacity-70'}`}
                  aria-hidden="true"
                >
                  {SMILEYS[Math.round((values.length <= 1 ? 1 : i / (values.length - 1)) * 4)]}
                </span>
                <span className={`text-xs ${isSelected ? 'font-semibold text-slate-800' : 'text-slate-500'}`}>{v}</span>
              </>
            ))
          )}
        </div>
      );
    }
    if (style === 'numbers' || style === 'nps') {
      return (
        <div className="flex items-end gap-1.5 flex-wrap">
          {values.map((v) =>
            radio(v, (isSelected) => (
              <span
                className={`w-10 h-10 flex items-center justify-center rounded-md border text-sm font-medium transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400'}`}
                aria-hidden="true"
              >
                {v}
              </span>
            ))
          )}
        </div>
      );
    }
    if (style === 'descriptive') {
      return (
        <div className="flex items-stretch gap-1.5 flex-wrap">
          {values.map((v) =>
            radio(v, (isSelected) => (
              <span
                className={`min-w-[3.5rem] px-3 py-2 flex flex-col items-center justify-center rounded-md border text-center transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400'}`}
                aria-hidden="true"
              >
                <span className="text-sm font-semibold">{v}</span>
                {perValueLabels[String(v)] && (
                  <span className="text-[11px] leading-tight mt-0.5">{perValueLabels[String(v)]}</span>
                )}
              </span>
            ))
          )}
        </div>
      );
    }
    // slider
    const sliderValue = selected !== null && selected !== 'na' ? selected : min;
    return (
      <div className="max-w-md">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={sliderValue}
          onChange={(e) => pick(Number(e.target.value))}
          disabled={disabled || selected === 'na'}
          className="w-full accent-blue-600"
          aria-label={field.label}
          aria-valuetext={selected === null || selected === 'na' ? 'No score selected' : optionAria(sliderValue)}
          data-testid={`score-slider-${field.id}`}
        />
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>{min}{lowLabel ? ` — ${lowLabel}` : ''}</span>
          <span className="font-semibold text-slate-800" aria-live="polite">
            {selected === null || selected === 'na' ? '–' : selected}
          </span>
          <span>{max}{highLabel ? ` — ${highLabel}` : ''}</span>
        </div>
      </div>
    );
  };

  return (
    <fieldset
      className="border-0 p-0 m-0"
      aria-required={field.required || undefined}
      data-testid={`score-field-${field.id}`}
    >
      <legend className="sr-only">
        {(questionNumber ? `Question ${questionNumber}. ` : '') + (field.label || 'Score')}
      </legend>
      {renderOptions()}
      {(lowLabel || highLabel) && style !== 'slider' && (
        <div className="flex justify-between text-xs text-slate-500 mt-1 max-w-md">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      )}
      {field.allow_na === true && (
        <div className="mt-2">
          {radio('na', (isSelected) => (
            <span
              className={`inline-flex px-3 py-1.5 rounded-md border text-xs transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 ${isSelected ? 'bg-slate-700 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'}`}
              aria-hidden="true"
            >
              {field.na_label || 'Not applicable'}
            </span>
          ), 'items-start')}
        </div>
      )}
    </fieldset>
  );
}
