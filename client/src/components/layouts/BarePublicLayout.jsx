import React from "react";
import { InstalledFontsLoader } from "@/lib/installedFonts";

export default function BarePublicLayout({ children }) {
  return (
    <div className="flex flex-col min-h-screen bg-white" style={{ fontFamily: 'Poppins, sans-serif' }}>
      {/* Base font (Poppins) below; tenant installed fonts loaded dynamically (Task #2549). */}
      <InstalledFontsLoader />
      {/* Google Fonts - Poppins */}
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet" />
      
      {/* Font Definitions */}
      <style>
        {`
          @font-face {
            font-family: 'Degular Medium';
            src: url('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff') format('woff');
            font-weight: 500;
            font-style: normal;
            font-display: swap;
          }

          body, html {
            font-family: 'Poppins', sans-serif;
          }

          h1 {
            font-family: 'Degular Medium', 'Poppins', sans-serif;
          }
        `}
      </style>

      {/* No header - completely bare */}
      
      {/* Main Content Area */}
      <main className="flex-1">
        {children}
      </main>

      {/* Simple footer */}
      <footer className="bg-white border-t border-slate-200 py-6">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <a 
            href="https://isaasi.co.uk" 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-block mb-3 hover:opacity-80 transition-opacity"
          >
            <img 
              src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png" 
              alt="isaasi"
              className="w-[50px] mx-auto"
            />
          </a>
          <p className="text-sm text-slate-600">
            <span style={{ color: '#a30062' }}>i</span>Connect by{' '}
            <a 
              href="https://isaasi.co.uk" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:opacity-80 transition-opacity font-medium underline"
              style={{ color: '#a30062' }}
            >
              isaasi
            </a>
            {' '}- © Copyright {new Date().getFullYear() === 2025 ? '2025' : `2025-${new Date().getFullYear()}`}
          </p>
        </div>
      </footer>
    </div>
  );
}