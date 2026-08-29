import { useCallback, useState, useRef } from "react";
import { Upload, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface FileUploaderProps {
  onFileContent: (content: string, fileName: string) => void;
  disabled?: boolean;
}

export function FileUploader({ onFileContent, disabled }: FileUploaderProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [loadedFile, setLoadedFile] = useState<{ name: string; size: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".txt")) {
        alert("Please upload a .txt file");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setLoadedFile({ name: file.name, size: file.size });
        onFileContent(text, file.name);
      };
      reader.readAsText(file);
    },
    [onFileContent],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const clearFile = () => {
    setLoadedFile(null);
    onFileContent("", "");
    if (inputRef.current) inputRef.current.value = "";
  };

  if (loadedFile) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 shadow-sm">
        <FileText className="h-5 w-5 text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-stone-200 truncate">{loadedFile.name}</p>
          <p className="text-xs text-stone-400">
            {(loadedFile.size / 1024 / 1024).toFixed(2)} MB •{" "}
            {Math.floor(loadedFile.size / 3).toLocaleString()} characters approx.
          </p>
        </div>
        {!disabled && (
          <button
            onClick={clearFile}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-stone-500 hover:text-red-400 transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all duration-200",
        isDragOver
          ? "border-amber-400 bg-amber-500/5 scale-[1.01]"
          : "border-stone-700 bg-stone-900/50 hover:border-amber-500/40 hover:bg-stone-900",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <div className={cn(
        "flex h-12 w-12 items-center justify-center rounded-xl transition-colors",
        isDragOver ? "bg-amber-500/20 text-amber-400" : "bg-stone-800 text-stone-500",
      )}>
        <Upload className="h-5 w-5" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-stone-300">
          {isDragOver ? "Drop your file here" : "Drag & drop a Chinese novel .txt file"}
        </p>
        <p className="text-xs text-stone-500 mt-1">
          or click to browse • supports files up to 100 MB
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
        className="hidden"
      />
    </div>
  );
}
