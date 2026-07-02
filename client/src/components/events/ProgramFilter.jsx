import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter } from "lucide-react";

export default function ProgramFilter({ programs, selectedProgram, onProgramChange }) {
  return (
    <div className="flex items-center gap-2 min-w-[200px]">
      <Filter className="w-4 h-4 text-slate-400" />
      <Select value={selectedProgram} onValueChange={onProgramChange}>
        <SelectTrigger>
          <SelectValue placeholder="Filter by program" />
        </SelectTrigger>
        <SelectContent>
          {programs.map(program => (
            <SelectItem key={program} value={program}>
              {program === "all" 
                ? "All Events" 
                : program === "one-off" 
                  ? "One-off Events" 
                  : program}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}