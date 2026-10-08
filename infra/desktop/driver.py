"""Private line-delimited RPC over stdin/stdout; no listener or model credentials.
The same driver serves an isolated X11 desktop or a logged-in native user.
"""
import base64, contextlib, ctypes, io, json, os, sys, time

def check_session():
    if sys.platform == 'win32':
        session = ctypes.c_ulong()
        ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session))
        if session.value == 0:
            raise RuntimeError('Windows desktop needs the logged-in user helper; SYSTEM Session 0 cannot control it.')
        user32 = ctypes.windll.user32
        user32.OpenInputDesktop.restype = ctypes.c_void_p
        user32.CloseDesktop.argtypes = [ctypes.c_void_p]
        desktop = user32.OpenInputDesktop(0, False, 0x0100)
        if not desktop:
            raise RuntimeError('Unlock Windows and close secure/UAC screens before desktop control.')
        user32.CloseDesktop(desktop)
    elif sys.platform == 'darwin':
        import Quartz
        if not Quartz.AXIsProcessTrusted():
            raise RuntimeError('Allow Accessibility for the desktop helper Python in macOS System Settings.')
        if hasattr(Quartz, 'CGPreflightScreenCaptureAccess') and not Quartz.CGPreflightScreenCaptureAccess():
            raise RuntimeError('Allow Screen Recording for the desktop helper Python in macOS System Settings.')
    elif not os.environ.get('DISPLAY') or os.environ.get('XDG_SESSION_TYPE') == 'wayland':
        raise RuntimeError('An X11 session is required. Use the virtual desktop on a headless/Wayland host.')

gui = None
held = set()
geometry = None

def ready():
    global gui
    check_session()
    if gui is None:
        import pyautogui
        gui = pyautogui
        gui.PAUSE = 0.02
        # Keep PyAutoGUI's corner fail-safe enabled on real desktops.
        gui.FAILSAFE = os.environ.get('OPENMUSE_VIRTUAL_DESKTOP') != '1'
    return gui

def mapping():
    w, h = ready().size()
    scale = min(1280 / w, 800 / h)
    return w, h, scale, (1280 - round(w * scale)) // 2, (800 - round(h * scale)) // 2

def point(p):
    global geometry
    w,h,scale,ox,oy = mapping()
    if geometry is not None and geometry != (w,h):
        raise RuntimeError('Display size changed. Take a new screenshot before input.')
    x,y = p
    if not (ox <= x < ox+round(w*scale) and oy <= y < oy+round(h*scale)):
        raise RuntimeError('Coordinate is outside the captured display.')
    return int((x-ox)/scale), int((y-oy)/scale)

def screenshot(region=None, live=False):
    global geometry
    from PIL import Image
    g=ready();w,h,scale,ox,oy=mapping();geometry=(w,h)
    raw=g.screenshot().convert('RGB')
    # Retina screenshots may be larger than the logical display used by input.
    image=Image.new('RGB',(1280,800),'black')
    image.paste(raw.resize((round(w*scale),round(h*scale))), (ox,oy))
    if region:
        x1,y1,x2,y2=region
        if x2<=x1 or y2<=y1: raise RuntimeError('Invalid zoom region.')
        dw,dh=round(w*scale),round(h*scale)
        if x1<ox or y1<oy or x2>ox+dw or y2>oy+dh:
            raise RuntimeError('Zoom region must stay inside the displayed screen, excluding black bars.')
        # Crop the original capture, not the downscaled observation: zoom must
        # recover readable text on Retina and ultrawide displays.
        rw,rh=raw.size
        image=raw.crop((round((x1-ox)*rw/dw),round((y1-oy)*rh/dh),round((x2-ox)*rw/dw),round((y2-oy)*rh/dh)))
        image.thumbnail((1280,800))
    out=io.BytesIO();image.save(out,format='JPEG' if live else 'PNG',**({'quality':75} if live else {}))
    return {'data':base64.b64encode(out.getvalue()).decode('ascii'),'media_type':'image/jpeg' if live else 'image/png'}

def key_name(key):
    names={'Control':'ctrl','Meta':'command' if sys.platform=='darwin' else 'win','Alt':'alt','Shift':'shift','Enter':'enter','Escape':'esc','Space':'space','Backspace':'backspace','Delete':'delete','Tab':'tab','ArrowUp':'up','ArrowDown':'down','ArrowLeft':'left','ArrowRight':'right','Home':'home','End':'end','PageUp':'pageup','PageDown':'pagedown'}
    result=names.get(key,key.lower())
    if result not in ready().KEYBOARD_KEYS: raise RuntimeError('Unsupported key.')
    return result

def text_input(text):
    if sys.platform=='win32':
        # Unicode SendInput does not modify the user's clipboard.
        from ctypes import wintypes
        class KI(ctypes.Structure):
            _fields_=[('vk',wintypes.WORD),('scan',wintypes.WORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
        class MI(ctypes.Structure):
            _fields_=[('dx',wintypes.LONG),('dy',wintypes.LONG),('data',wintypes.DWORD),('flags',wintypes.DWORD),('time',wintypes.DWORD),('extra',ctypes.c_size_t)]
        class U(ctypes.Union): _fields_=[('ki',KI),('mi',MI)]
        class INPUT(ctypes.Structure): _fields_=[('type',wintypes.DWORD),('u',U)]
        data=text.encode('utf-16-le')
        for i in range(0,len(data),2):
            code=int.from_bytes(data[i:i+2],'little')
            events=(INPUT*2)(INPUT(1,U(ki=KI(0,code,4,0,0))),INPUT(1,U(ki=KI(0,code,6,0,0))))
            if ctypes.windll.user32.SendInput(2,events,ctypes.sizeof(INPUT))!=2: raise RuntimeError('The desktop refused keyboard input.')
    elif sys.platform=='darwin':
        import Quartz
        for chunk in [text[i:i+20] for i in range(0,len(text),20)]:
            for down in (True,False):
                event=Quartz.CGEventCreateKeyboardEvent(None,0,down)
                Quartz.CGEventKeyboardSetUnicodeString(event,len(chunk.encode('utf-16-le'))//2,chunk)
                Quartz.CGEventPost(Quartz.kCGHIDEventTap,event)
    else:
        # X11 Unicode input via clipboard, restoring its previous text afterwards.
        import pyperclip
        old=pyperclip.paste()
        try:
            from Xlib import display
            connection=display.Display()
            try:
                active=connection.screen().root.get_full_property(connection.intern_atom('_NET_ACTIVE_WINDOW'),0)
                classes=connection.create_resource_object('window',active.value[0]).get_wm_class() if active and active.value else ()
            finally: connection.close()
            terminal=any(any(name in value.lower() for name in ('xterm','terminal','konsole','kitty','alacritty')) for value in (classes or ()))
            pyperclip.copy(text);ready().hotkey(*(['ctrl','shift','v'] if terminal else ['ctrl','v']));time.sleep(.2)
        finally: pyperclip.copy(old)

def execute(a):
    g=ready();op=a['action']
    if op=='status': return {'available':True,'width':1280,'height':800,'display':list(g.size()),'platform':sys.platform}
    if op=='screenshot': return screenshot()
    if op=='frame': return screenshot(live=True)
    if op=='zoom': return screenshot(a['region'])
    if op=='reset':
        for key in list(held):g.keyUp(key)
        held.clear()
        for button in ('left','middle','right'):g.mouseUp(button=button)
        return None
    if op=='cursor_position':
        x,y=g.position();_,_,s,ox,oy=mapping();return {'x':round(x*s)+ox,'y':round(y*s)+oy}
    if op=='type': text_input(a['text'])
    elif op=='key':
        keys=[key_name(k) for k in a['text'].split('+')]
        for _ in range(a.get('repeat',1)): g.hotkey(*keys)
    elif op=='key_event':
        k=key_name(a['key']);g.keyDown(k) if a['down'] else g.keyUp(k)
        held.add(k) if a['down'] else held.discard(k)
    elif op=='pointer_event':
        g.moveTo(*point(a['coordinate']))
        old=a['previous'];new=a['buttons']
        for bit,button in ((1,'left'),(2,'middle'),(4,'right')):
            if bool(old&bit)!=bool(new&bit): g.mouseDown(button=button) if new&bit else g.mouseUp(button=button)
        if new&8:g.scroll(1)
        if new&16:g.scroll(-1)
    elif op=='mouse_move':g.moveTo(*point(a['coordinate']))
    elif op=='left_click_drag':g.moveTo(*point(a['start_coordinate']));g.dragTo(*point(a['coordinate']),duration=.3,button='left')
    elif op.endswith('click'):
        g.click(*point(a['coordinate']),clicks={'double_click':2,'triple_click':3}.get(op,1),interval=.08,button={'right_click':'right','middle_click':'middle'}.get(op,'left'))
    elif op=='scroll':
        if a.get('coordinate'):g.moveTo(*point(a['coordinate']))
        d=a['scroll_direction'];n=a['scroll_amount']*(1 if d in ('up','right') else -1)
        g.hscroll(n) if d in ('left','right') else g.scroll(n)
    elif op=='wait':time.sleep(a['duration'])
    else:raise RuntimeError('Unsupported desktop action.')
    return None

for line in sys.stdin:
    try:
        if len(line)>65536:raise RuntimeError('Request too large.')
        request=json.loads(line)
        # Xlib/PyAutoGUI may print startup notices; stdout belongs only to RPC.
        with contextlib.redirect_stdout(sys.stderr): result=execute(request)
        print(json.dumps({'result':result},ensure_ascii=True),flush=True)
    except RuntimeError as e: print(json.dumps({'error':str(e)}),flush=True)
    except Exception: print(json.dumps({'error':'Desktop driver unavailable or input rejected. Check the helper dependencies, session and OS permissions.'}),flush=True)
