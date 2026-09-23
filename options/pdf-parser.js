/**
 * JobFill AI - PDF Text Extractor powered by Mozilla PDF.js
 * Extracts high-fidelity text, line breaks, and metadata from any PDF CV/Resume.
 */

class PdfTextExtractor {
  static async extractText(fileOrBuffer) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("La librería PDF.js no está cargada. Asegúrate de que pdf.min.js esté presente.");
    }

    // Configure local worker script
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("options/pdf.worker.min.js");
      } else {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
      }
    } catch (e) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
    }

    let arrayBuffer;
    if (fileOrBuffer instanceof ArrayBuffer) {
      arrayBuffer = fileOrBuffer;
    } else if (fileOrBuffer instanceof Uint8Array) {
      arrayBuffer = fileOrBuffer.buffer;
    } else if (fileOrBuffer && typeof fileOrBuffer.arrayBuffer === "function") {
      arrayBuffer = await fileOrBuffer.arrayBuffer();
    } else {
      throw new Error("Formato de archivo inválido para extracción de PDF.");
    }

    const typedArray = new Uint8Array(arrayBuffer);
    const loadingTask = pdfjsLib.getDocument({
      data: typedArray,
      cMapUrl: undefined,
      cMapPacked: true,
      standardFontDataUrl: undefined
    });

    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;

    if (totalPages === 0) {
      throw new Error("El documento PDF no tiene páginas.");
    }

    const pageTexts = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent({ normalizeWhitespace: true });
      
      let lastY = null;
      let lastX = null;
      let pageString = "";

      for (const item of textContent.items) {
        if (!item.str && item.str !== " ") continue;

        const currentX = item.transform ? item.transform[4] : 0;
        const currentY = item.transform ? item.transform[5] : 0;

        if (lastY !== null) {
          const yDiff = Math.abs(currentY - lastY);
          if (yDiff > 6) {
            // New line
            pageString += "\n";
            if (yDiff > 16) {
              // Paragraph spacing
              pageString += "\n";
            }
          } else if (lastX !== null && (currentX - lastX) > 6 && !pageString.endsWith(" ") && !item.str.startsWith(" ")) {
            pageString += " ";
          }
        }

        pageString += item.str;
        lastY = currentY;
        lastX = currentX + (item.width || 0);
      }

      const cleanedPage = pageString
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+\n/g, "\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (cleanedPage) {
        pageTexts.push(cleanedPage);
      }
    }

    const fullText = pageTexts.join("\n\n--- Salto de Página ---\n\n").trim();
    if (!fullText) {
      throw new Error("El archivo PDF no contiene texto digital legible. Si es una fotografía o un escaneo de imagen, conviértelo o pega el texto directamente.");
    }

    return {
      text: fullText,
      pageCount: totalPages
    };
  }
}

/**
 * Local Heuristic CV Parser
 * Parses CV raw text into structured database cards using regex and heuristic layout detection.
 * Works 100% offline as a reliable instant fallback when Claude API is not configured or fails.
 */
class LocalHeuristicCvParser {
  static parse(cvText) {
    if (!cvText || !cvText.trim()) {
      return { experiences: [], projects: [], education: [] };
    }

    const lines = cvText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("--- Salto de Página"));

    const experiences = [];
    const projects = [];
    const education = [];
    let skillsList = [];
    let headline = "";
    let summary = "";

    // Common technology dictionary for auto-tagging
    const TECH_KEYWORDS = [
      "JavaScript", "TypeScript", "Python", "React", "Node.js", "Vue", "Angular", "Next.js",
      "Java", "C#", ".NET", "PHP", "Go", "Golang", "Rust", "C++", "SQL", "PostgreSQL",
      "MySQL", "MongoDB", "Redis", "Docker", "Kubernetes", "AWS", "Azure", "GCP", "Git",
      "GraphQL", "REST APIs", "Tailwind", "HTML5", "CSS3", "Linux", "FastAPI", "Django", "Flask"
    ];

    const detectedTech = TECH_KEYWORDS.filter(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cvText));

    // Date range regex matcher (e.g. 2022 - Presente, 2020-2023, Ene 2021 - Dic 2022)
    const dateRangeRegex = /(\b(?:20\d\d|19\d\d)\b(?:\s*[-–—a/]\s*(?:presente|actualidad|current|present|\b(?:20\d\d|19\d\d)\b))|\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\s*[-–—a/]\s*(?:presente|actualidad|current|present|[a-z]+\.?\s+\d{4})/i;

    // Detect job experience blocks
    let currentExp = null;
    let inExpSection = false;
    let inEduSection = false;
    let inProjSection = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Section headers
      if (/^(?:experiencia|historial laboral|trayectoria|work experience|employment history)/i.test(line)) {
        inExpSection = true;
        inEduSection = false;
        inProjSection = false;
        continue;
      } else if (/^(?:educaci[oó]n|estudios|formaci[oó]n|education|academic)/i.test(line)) {
        inEduSection = true;
        inExpSection = false;
        inProjSection = false;
        continue;
      } else if (/^(?:proyectos|proyectos destacados|projects)/i.test(line)) {
        inProjSection = true;
        inExpSection = false;
        inEduSection = false;
        continue;
      } else if (/^(?:habilidades|skills|conocimientos|competencias)/i.test(line)) {
        inExpSection = false;
        inEduSection = false;
        inProjSection = false;
        continue;
      }

      // Check for dates indicating a new job experience
      const dateMatch = line.match(dateRangeRegex);
      if (dateMatch || (inExpSection && line.length < 60 && i + 1 < lines.length && lines[i + 1].match(dateRangeRegex))) {
        if (currentExp && (currentExp.company || currentExp.role)) {
          experiences.push(currentExp);
        }

        let period = dateMatch ? dateMatch[0] : "";
        let lineWithoutDate = line.replace(dateRangeRegex, "").trim().replace(/^[|\-–—,]\s*/, "").replace(/[|\-–—,]\s*$/, "");
        
        let company = "";
        let role = "";

        if (lineWithoutDate.includes("|") || lineWithoutDate.includes("-") || lineWithoutDate.includes("–") || lineWithoutDate.includes(" at ") || lineWithoutDate.includes(" en ")) {
          const parts = lineWithoutDate.split(/\||-|–|—|\bat\b|\ben\b/i).map(s => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            role = parts[0];
            company = parts[1];
          } else {
            role = parts[0] || lineWithoutDate;
          }
        } else if (lineWithoutDate) {
          role = lineWithoutDate;
        }

        currentExp = {
          id: `exp_${experiences.length + 1}`,
          company: company || "Empresa",
          role: role || "Cargo Profesional",
          period: period || "Período",
          description: "",
          achievements: "",
          technologies: ""
        };
        continue;
      }

      // Append description or achievements to current experience
      if (currentExp) {
        if (/^(?:logros?|achievements?|impacto|resultados?)/i.test(line)) {
          currentExp.achievements = (currentExp.achievements ? currentExp.achievements + " " : "") + line.replace(/^(?:logros?|achievements?|impacto):\s*/i, "");
        } else if (/^(?:tecnolog[ií]as?|stack|tools?)/i.test(line)) {
          currentExp.technologies = line.replace(/^(?:tecnolog[ií]as?|stack|tools?):\s*/i, "");
        } else if (line.startsWith("•") || line.startsWith("-") || line.startsWith("*")) {
          const cleanBullet = line.replace(/^[•\-\*]\s*/, "");
          if (/\b(?:\d+%|\$\d+|\boptimiz|\breduj|\baument|\bincrement|\bcre[oó]|\blider[oó])\b/i.test(cleanBullet)) {
            currentExp.achievements = (currentExp.achievements ? currentExp.achievements + "\n" : "") + "• " + cleanBullet;
          } else {
            currentExp.description = (currentExp.description ? currentExp.description + "\n" : "") + "• " + cleanBullet;
          }
        } else if (currentExp.description.length < 300) {
          currentExp.description = (currentExp.description ? currentExp.description + " " : "") + line;
        }
      }

      // Detect Education
      if (inEduSection && (/(?:ingenier[ií]a|licenciatura|t[ií]tulo|universidad|instituto|bachelor|degree|master|diplomado)/i.test(line))) {
        education.push({
          id: `edu_${education.length + 1}`,
          degree: line,
          institution: lines[i + 1] || "",
          year: line.match(/\b(20\d\d|19\d\d)\b/)?.[0] || ""
        });
      }

      // Detect Projects
      if (inProjSection && line.length < 80 && !line.startsWith("•") && !line.startsWith("-")) {
        projects.push({
          id: `proj_${projects.length + 1}`,
          name: line,
          description: lines[i + 1] || "",
          technologies: detectedTech.slice(0, 4).join(", ")
        });
      }
    }

    if (currentExp && (currentExp.company || currentExp.role)) {
      experiences.push(currentExp);
    }

    // Fallback if no specific dates detected: create a structured card from first paragraphs
    if (experiences.length === 0) {
      experiences.push({
        id: "exp_1",
        company: "Empresa Principal",
        role: lines[0] || "Profesional Especialista",
        period: "Últimos años",
        description: lines.slice(1, 4).join(" "),
        achievements: "Desarrollo y entrega exitosa de proyectos.",
        technologies: detectedTech.join(", ")
      });
    }

    // Infer headline & summary
    headline = experiences[0]?.role || "Profesional";
    summary = lines.slice(0, 3).join(" ").slice(0, 300);

    return {
      headline,
      summary,
      skills: detectedTech.join(", "),
      experiences,
      projects: projects.slice(0, 5),
      education: education.slice(0, 3),
      rawText: cvText,
      parsedAt: new Date().toISOString()
    };
  }
}

if (typeof window !== "undefined") {
  window.PdfTextExtractor = PdfTextExtractor;
  window.LocalHeuristicCvParser = LocalHeuristicCvParser;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PdfTextExtractor, LocalHeuristicCvParser };
}

