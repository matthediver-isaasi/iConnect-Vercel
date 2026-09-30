import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { User, Users, Link2 } from "lucide-react";

export default function RegistrationModeSelector({ mode, onModeChange, isFeatureExcluded, canSelfRegister = true }) {
  const modes = [
    {
      id: 'self',
      icon: User,
      title: 'Self Register',
      description: 'Register yourself only',
      featureId: 'element_SelfRegistration'
    },
    {
      id: 'colleagues',
      icon: Users,
      title: 'Register Attendees',
      description: 'Register your attendee(s) now'
    }
  ];

  // Filter out modes that are excluded by the user's role or ticket restrictions
  const availableModes = modes.filter(modeOption => {
    // Filter by feature exclusions
    if (modeOption.featureId && isFeatureExcluded) {
      if (isFeatureExcluded(modeOption.featureId)) return false;
    }
    // Filter self-registration based on ticket role restrictions
    if (modeOption.id === 'self' && !canSelfRegister) {
      return false;
    }
    return true;
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      {availableModes.map((modeOption) => {
        const Icon = modeOption.icon;
        const isSelected = mode === modeOption.id;
        
        return (
          <button
            key={modeOption.id}
            onClick={() => onModeChange(modeOption.id)}
            className="text-left"
          >
            <Card className={`border-2 transition-all cursor-pointer hover:shadow-md ${
              isSelected 
                ? 'border-green-600 bg-green-50' 
                : 'border-slate-200 hover:border-slate-300'
            }`}>
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-lg ${
                    isSelected ? 'bg-green-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-semibold mb-1 ${
                      isSelected ? 'text-green-900' : 'text-slate-900'
                    }`}>
                      {modeOption.title}
                    </h3>
                    <p className={`text-sm ${
                      isSelected ? 'text-green-700' : 'text-slate-600'
                    }`}>
                      {modeOption.description}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </button>
        );
      })}
    </div>
  );
}