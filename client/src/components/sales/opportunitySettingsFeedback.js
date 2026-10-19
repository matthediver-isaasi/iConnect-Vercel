export async function showOpportunitySettingsError(error, { reloadSettings, toast }) {
  // A 409 can also mean an occupied stage cannot be removed/reclassified.
  // Only a version conflict means another user changed the pipeline order.
  if (error.status === 409 && error.payload?.code === "STALE_UPDATE") {
    await reloadSettings();
    toast({
      title: "Stage order changed elsewhere",
      description: "Settings were reloaded. Review the latest order and try again.",
      variant: "destructive",
    });
    return;
  }
  toast({
    title: "Could not save settings",
    description: error.message,
    variant: "destructive",
  });
}
