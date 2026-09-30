import React, { createContext, useContext } from "react";

const BannerContext = createContext({
  belowFirstElementBanners: [],
});

export function BannerProvider({ children, belowFirstElementBanners = [] }) {
  return (
    <BannerContext.Provider value={{ belowFirstElementBanners }}>
      {children}
    </BannerContext.Provider>
  );
}

export function useBelowFirstElementBanners() {
  const context = useContext(BannerContext);
  return context.belowFirstElementBanners || [];
}
