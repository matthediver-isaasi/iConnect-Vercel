
import React, { useEffect } from "react";
import { createPageUrl } from "@/utils";

export default function HomePage() {
  useEffect(() => {
    window.location.href = createPageUrl('Login');
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-lg mb-4 p-2">
          <img 
            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/6cfe73a57_agcasRoundall.jpg"
            alt="Portal"
            className="w-full h-full object-contain"
          />
        </div>
        <p className="text-slate-600">Redirecting to login...</p>
      </div>
    </div>
  );
}
