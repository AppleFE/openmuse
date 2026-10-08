"""Opt-in native GUI acceptance: manipulates only its own temporary Tk window.
Run using the desktop venv: python infra/desktop/smoke.py artifact-directory
"""
import base64, ctypes, json, os, pathlib, subprocess, sys, threading, tkinter as tk
from PIL import Image
import io
if sys.platform=='win32':ctypes.windll.user32.SetProcessDPIAware()

out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
root=tk.Tk();root.title('OpenMuse desktop acceptance');root.geometry('700x260+80+80')
root.attributes('-topmost',True)
tk.Label(root,text='OpenMuse · Desktop SDK acceptance',font=('Arial',18)).pack(pady=20)
entry=tk.Entry(root,font=('Arial',18));entry.pack(fill='x',padx=30,pady=20)
result=tk.Label(root,text='Waiting for driver input',font=('Arial',14));result.pack()
driver=subprocess.Popen([sys.executable,'-u',str(pathlib.Path(__file__).with_name('driver.py'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding='utf8',creationflags=0x08000000 if sys.platform=='win32' else 0)
def rpc(value):
    driver.stdin.write(json.dumps(value)+'\n');driver.stdin.flush()
    response=json.loads(driver.stdout.readline())
    if 'error' in response:raise RuntimeError(response['error'])
    return response['result']
errors=[]
def test():
    try:
        status=rpc({'action':'status'});w,h=status['display'];scale=min(1280/w,800/h);ox=(1280-round(w*scale))//2;oy=(800-round(h*scale))//2
        rpc({'action':'screenshot'})
        x,y=entry.winfo_rootx()+70,entry.winfo_rooty()+15
        rpc({'action':'left_click','coordinate':[round(x*scale)+ox,round(y*scale)+oy]})
        if sys.platform=='win32':
            pid=ctypes.c_ulong();ctypes.windll.user32.GetWindowThreadProcessId(ctypes.windll.user32.GetForegroundWindow(),ctypes.byref(pid))
            if pid.value!=os.getpid():raise RuntimeError('Test window lost focus; no text will be sent.')
        rpc({'action':'type','text':'OpenMuse 화면 입력 검증 2026'})
        root.after(200,finish)
    except Exception as e:errors.append(str(e));root.after(0,root.destroy)
def finish():
    try:
        if entry.get()!='OpenMuse 화면 입력 검증 2026':raise RuntimeError('Unicode input did not reach the test window: '+entry.get())
        result.config(text='PASS · screenshot, coordinates, click, Unicode input')
        root.update_idletasks()
        image=rpc({'action':'screenshot'});Image.open(io.BytesIO(base64.b64decode(image['data']))).save(out/'desktop-smoke.png')
        (out/'desktop-smoke.json').write_text(json.dumps({'passed':True,'platform':sys.platform,'input':entry.get()},ensure_ascii=False),encoding='utf8')
        print('Desktop smoke passed')
    except Exception as e:errors.append(str(e))
    root.destroy()
root.after(500,lambda:threading.Thread(target=test,daemon=True).start())
root.after(30000,root.destroy)
try:root.mainloop()
finally:driver.stdin.close();driver.terminate();driver.wait(timeout=5)
if errors:raise RuntimeError('; '.join(errors))
