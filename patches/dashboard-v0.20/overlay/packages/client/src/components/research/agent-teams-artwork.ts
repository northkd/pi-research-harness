function svgUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

// 统一设计系统：低饱和度莫兰迪色块（Muted Morandi Flat Color Blocks）
// 去除复杂渐变、3D质感与尖锐细线，采用温润纯净的低饱和度实心几何色块，完美契合暗色现代 IDE / Dashboard UI

export const leadArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#4B3B2B"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#68523D" stroke-width="1"/>
  <path d="M16 6.5L18.8 13.2L25.5 16L18.8 18.8L16 25.5L13.2 18.8L6.5 16L13.2 13.2Z" fill="#FDF7EE"/>
  <circle cx="16" cy="16" r="2.5" fill="#C99F66"/>
</svg>
`);

export const researcherArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#28394A"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#3A5168" stroke-width="1"/>
  <circle cx="14" cy="14" r="6" fill="none" stroke="#F0F5FA" stroke-width="2.4"/>
  <path d="M18.2 18.2L23.8 23.8" stroke="#F0F5FA" stroke-width="2.8" stroke-linecap="round"/>
  <circle cx="14" cy="14" r="2.5" fill="#7FA4BF"/>
</svg>
`);

export const engineerArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#382E47"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#4E4061" stroke-width="1"/>
  <path d="M12 10.5L6.5 16L12 21.5" stroke="#F3EEF8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M20 10.5L25.5 16L20 21.5" stroke="#F3EEF8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M17.5 9.5L14.5 22.5" stroke="#A794C4" stroke-width="2.4" stroke-linecap="round"/>
</svg>
`);

export const dataArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#243B2E"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#365442" stroke-width="1"/>
  <rect x="7.5" y="16" width="4.2" height="9" rx="2.1" fill="#7BB793"/>
  <rect x="13.9" y="8" width="4.2" height="17" rx="2.1" fill="#EFF7F2"/>
  <rect x="20.3" y="12" width="4.2" height="13" rx="2.1" fill="#A8D4BC"/>
</svg>
`);

export const qaArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#25383E"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#364E56" stroke-width="1"/>
  <path d="M16 7L23.5 10.2V15.5C23.5 19.8 20.3 23.8 16 25C11.7 23.8 8.5 19.8 8.5 15.5V10.2L16 7Z" fill="#75A5B2"/>
  <path d="M12.8 16L15.2 18.4L19.5 14" stroke="#1D2A2E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>
`);

export const securityArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#442A2A"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#5D3A3A" stroke-width="1"/>
  <path d="M11.5 13V9.5C11.5 7 13.5 5 16 5C18.5 5 20.5 7 20.5 9.5V13" stroke="#F7EEEE" stroke-width="2.4" stroke-linecap="round" fill="none"/>
  <rect x="8.5" y="12" width="15" height="13" rx="3.5" fill="#BF7777"/>
  <circle cx="16" cy="17.2" r="1.6" fill="#F7EEEE"/>
  <rect x="15.2" y="18" width="1.6" height="3" rx="0.8" fill="#F7EEEE"/>
</svg>
`);

export const docsArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#2C3345"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#3E4760" stroke-width="1"/>
  <path d="M9.5 6.5H17.5L22.5 11.5V24.5C22.5 25.6 21.6 26.5 20.5 26.5H9.5C8.4 26.5 7.5 25.6 7.5 24.5V8.5C7.5 7.4 8.4 6.5 9.5 6.5Z" fill="#F0F3F9"/>
  <path d="M17.5 6.5V11.5H22.5" fill="#8B9CBE"/>
  <rect x="10.5" y="14.5" width="9" height="1.8" rx="0.9" fill="#4B5675"/>
  <rect x="10.5" y="18" width="7" height="1.8" rx="0.9" fill="#4B5675"/>
  <rect x="10.5" y="21.5" width="5" height="1.8" rx="0.9" fill="#8B9CBE"/>
</svg>
`);

export const designerArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#422B36"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#5A3A49" stroke-width="1"/>
  <circle cx="13.5" cy="15.5" r="6" fill="#F4E6ED"/>
  <circle cx="18.5" cy="16.5" r="5.5" fill="#C27A97" opacity="0.9"/>
  <path d="M16 11.2C17.5 12.3 18.5 13.8 18.5 15.5C18.5 17.2 17.5 18.7 16 19.8C14.5 18.7 13.5 17.2 13.5 15.5C13.5 13.8 14.5 12.3 16 11.2Z" fill="#7E475E"/>
</svg>
`);

export const operatorArt = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#2E3137"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#41454C" stroke-width="1"/>
  <rect x="7" y="10.5" width="18" height="3" rx="1.5" fill="#4A4E57"/>
  <circle cx="12" cy="12" r="3.5" fill="#F0F2F5"/>
  <rect x="7" y="18.5" width="18" height="3" rx="1.5" fill="#4A4E57"/>
  <circle cx="20" cy="20" r="3.5" fill="#9DA4B0"/>
</svg>
`);

// 动作角标同样采用极简低饱和度实心色块
export const actionWorking = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <circle cx="8" cy="8" r="7.5" fill="#1C3828" stroke="#2B543D" stroke-width="1"/>
  <path d="M8.5 3L4.5 8.5H8L7.5 13L11.5 7.5H8L8.5 3Z" fill="#69C28F"/>
</svg>
`);

export const actionThinking = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <circle cx="8" cy="8" r="7.5" fill="#1F2F3E" stroke="#2F465C" stroke-width="1"/>
  <circle cx="4.8" cy="8" r="1.3" fill="#88B4D4"/>
  <circle cx="8" cy="8" r="1.3" fill="#88B4D4"/>
  <circle cx="11.2" cy="8" r="1.3" fill="#88B4D4"/>
</svg>
`);

export const actionSleeping = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <circle cx="8" cy="8" r="7.5" fill="#26282E" stroke="#3A3D46" stroke-width="1"/>
  <path d="M9.2 4.5C7.2 5 5.8 6.7 5.8 8.8C5.8 11.2 7.7 12.8 10 12.8C10.7 12.8 11.3 12.6 11.8 12.3C9.8 12.3 8.2 10.6 8.2 8.6C8.2 7 9.1 5.6 10.2 4.9C9.9 4.6 9.5 4.5 9.2 4.5Z" fill="#9EA4AF"/>
</svg>
`);

export const actionCelebrating = svgUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <circle cx="8" cy="8" r="7.5" fill="#3D2E1E" stroke="#5C452E" stroke-width="1"/>
  <path d="M8 3.5L9.3 6.7L12.5 8L9.3 9.3L8 12.5L6.7 9.3L3.5 8L6.7 6.7L8 3.5Z" fill="#E0B777"/>
</svg>
`);

export function getMemberArt(roleName: string, isCaptain: boolean = false): string {
  if (isCaptain) return leadArt;
  const r = (roleName || "").toLowerCase();
  if (r.includes("data") || r.includes("calc") || r.includes("numeric") || r.includes("metric") || r.includes("数值")) {
    return dataArt;
  }
  if (r.includes("critic") || r.includes("review") || r.includes("audit") || r.includes("security") || r.includes("审查") || r.includes("对抗") || r.includes("安全")) {
    return securityArt;
  }
  if (r.includes("mainline") || r.includes("supervis") || r.includes("ssh") || r.includes("queue") || r.includes("engineer") || r.includes("收敛") || r.includes("架构")) {
    return engineerArt;
  }
  if (r.includes("writ") || r.includes("paper") || r.includes("doc") || r.includes("写作") || r.includes("论文")) {
    return docsArt;
  }
  if (r.includes("qa") || r.includes("test") || r.includes("verif") || r.includes("质检") || r.includes("验证")) {
    return qaArt;
  }
  if (r.includes("design") || r.includes("arch") || r.includes("设计")) {
    return designerArt;
  }
  if (r.includes("operator") || r.includes("worker") || r.includes("dispatch") || r.includes("调度")) {
    return operatorArt;
  }
  return researcherArt;
}

export function getActionArt(status: string): string {
  const s = (status || "").toLowerCase();
  if (s.includes("stream") || s.includes("run") || s.includes("start") || s.includes("work")) {
    return actionWorking;
  }
  if (s.includes("think") || s.includes("wait") || s.includes("queue") || s.includes("plan")) {
    return actionThinking;
  }
  if (s.includes("complete") || s.includes("converge") || s.includes("done")) {
    return actionCelebrating;
  }
  return actionSleeping;
}
