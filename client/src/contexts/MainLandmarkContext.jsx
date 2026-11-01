import { createContext, useContext } from 'react';

// A React-only boundary: declaring landmark ownership must not add layout DOM.
export const MainLandmarkContext = createContext(false);

export function useCanvasStageTag(embedded = false) {
  const hasMainLandmark = useContext(MainLandmarkContext);
  return embedded || hasMainLandmark ? 'div' : 'main';
}
