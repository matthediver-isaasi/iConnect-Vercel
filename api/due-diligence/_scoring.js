export function calculateDynamicScore(formValues, scoringRules) {
  const rules = scoringRules.rules || [];
  const breakdown = [];
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const rule of rules) {
    const fieldValue = formValues[rule.field];
    const weight = rule.weight || 1;
    let fieldScore = 0;

    if (rule.type === 'notEmpty') {
      fieldScore = (fieldValue && fieldValue.toString().trim() !== '') ? (rule.notEmptyScore || 100) : 0;
    } else if (rule.type === 'option' && rule.scoring) {
      const valueStr = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '').toString();
      fieldScore = rule.scoring[valueStr] || rule.scoring['*'] || 0;
    } else if (rule.type === 'range') {
      const numValue = parseFloat(fieldValue);
      if (!isNaN(numValue) && rule.ranges) {
        for (const range of rule.ranges) {
          if (numValue >= (range.min || -Infinity) && numValue <= (range.max || Infinity)) {
            fieldScore = range.score || 0;
            break;
          }
        }
      }
    }

    breakdown.push({
      field: rule.field,
      value: fieldValue,
      score: fieldScore,
      weight: weight,
      weighted_score: fieldScore * weight
    });

    totalWeightedScore += fieldScore * weight;
    totalWeight += weight;
  }

  const finalScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

  return {
    score: Math.min(100, Math.max(0, finalScore)),
    breakdown
  };
}

export function calculateTrafficLightScore(responses, staticQuestions, notApplicable = {}) {
  const breakdown = [];
  let greenCount = 0;
  let amberCount = 0;
  let redCount = 0;
  let totalQuestions = 0;
  let naCount = 0;
  let totalWeightedScore = 0;
  let totalWeight = 0;

  const questions = staticQuestions.filter(q => q.type !== 'header');

  for (const question of questions) {
    const isNA = notApplicable[question.id] === true;
    const response = responses[question.id];
    const weight = question.weight || 1;
    
    if (isNA) {
      naCount++;
      breakdown.push({
        question_id: question.id,
        question: question.question || question.label,
        response: 'not_applicable',
        weight: 0,
        excluded: true
      });
      continue;
    }
    
    totalQuestions++;
    totalWeight += weight;

    // Handle both formats: literal green/amber/red OR option IDs
    let responseLabel = response;
    let optionScore = 0;
    
    if (response === 'green') {
      greenCount++;
      optionScore = 100;
    } else if (response === 'amber') {
      amberCount++;
      optionScore = 50;
    } else if (response === 'red') {
      redCount++;
      optionScore = 0;
    } else if (response && question.options) {
      // Look up the option by ID to get its score and label
      const selectedOption = question.options.find(opt => opt.id === response);
      if (selectedOption) {
        responseLabel = selectedOption.label?.toLowerCase() || response;
        // Use option's score (typically 10/5/0 for green/amber/red) - normalize to 0-100 scale
        // Standard: green=10, amber=5, red=0 -> scale to 100/50/0
        const rawScore = selectedOption.score ?? 0;
        optionScore = rawScore * 10; // 10 -> 100, 5 -> 50, 0 -> 0
        
        if (responseLabel === 'green') greenCount++;
        else if (responseLabel === 'amber') amberCount++;
        else if (responseLabel === 'red') redCount++;
      }
    }

    totalWeightedScore += optionScore * weight;

    breakdown.push({
      question_id: question.id,
      question: question.question || question.label,
      response: responseLabel || 'unanswered',
      weight: weight,
      score: optionScore
    });
  }

  let score = 0;
  if (totalWeight > 0) {
    score = Math.round(totalWeightedScore / totalWeight);
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    counts: { green: greenCount, amber: amberCount, red: redCount, total: totalQuestions, not_applicable: naCount }
  };
}

export function determineRiskLevel(score, customRiskLevels) {
  const defaultLevels = [
    { name: 'low', threshold: 80 },
    { name: 'medium', threshold: 50 },
    { name: 'high', threshold: 20 },
    { name: 'critical', threshold: 0 }
  ];

  const levels = (customRiskLevels && customRiskLevels.length > 0) 
    ? customRiskLevels.map(l => ({ name: l.name.toLowerCase().replace(/\s+/g, '_'), threshold: l.threshold }))
    : defaultLevels;

  const sortedLevels = [...levels].sort((a, b) => b.threshold - a.threshold);

  for (const level of sortedLevels) {
    if (score >= level.threshold) {
      return level.name;
    }
  }

  return sortedLevels[sortedLevels.length - 1]?.name || 'unknown';
}
