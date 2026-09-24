import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../../native";
export type DelightPreferences={interfaceSounds:boolean;completionSounds:boolean;reminderSounds:boolean;volume:number;celebrations:boolean;momentumDisplay:boolean;weeklyGoalTasks:number;lastWeeklyGoalWeek:string};
export const defaultDelightPreferences:DelightPreferences={interfaceSounds:false,completionSounds:false,reminderSounds:false,volume:.55,celebrations:true,momentumDisplay:true,weeklyGoalTasks:0,lastWeeklyGoalWeek:""};
export async function loadDelightPreferences(){return isDesktop()?invoke<DelightPreferences>("get_delight_preferences"):defaultDelightPreferences;}
export async function saveDelightPreferences(preferences:DelightPreferences){return isDesktop()?invoke<DelightPreferences>("set_delight_preferences",{preferences}):preferences;}
export function playInterfaceSound(volume:number){
  if(volume<=0||document.hidden||!window.AudioContext)return;
  try{
    const context=new AudioContext();
    const oscillator=context.createOscillator();
    const gain=context.createGain();
    oscillator.type="sine";
    oscillator.frequency.setValueAtTime(620,context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(780,context.currentTime+.07);
    gain.gain.setValueAtTime(Math.min(1,volume)*.045,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.09);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime+.09);
    oscillator.onended=()=>void context.close();
  }catch{ /* Audio may be unavailable on this device or before user activation. */ }
}
export function playCompletionSound(volume:number){if(!window.AudioContext)return;const context=new AudioContext();const gain=context.createGain();gain.gain.value=Math.max(0,Math.min(1,volume))*.12;gain.connect(context.destination);[523.25,659.25,783.99].forEach((frequency,index)=>{const oscillator=context.createOscillator();oscillator.frequency.value=frequency;oscillator.connect(gain);const start=context.currentTime+index*.08;oscillator.start(start);oscillator.stop(start+.11);});setTimeout(()=>void context.close(),600);}
