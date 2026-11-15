import math,json,pathlib
g=json.loads((pathlib.Path(__file__).parent/"glyphs.json").read_text())
P='#260B40';L='#A477F5';I='#F8F4EB'
def svg(w,h,body):return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>'
def rect(x,y,w,h,c,rx=0):return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{c}"/>'
def label(x,y,s,size=18,c=P):return f'<text x="{x}" y="{y}" font-family="Helvetica,Arial,sans-serif" font-size="{size}" fill="{c}">{s}</text>'
def mark(x,y,size,c=L,micro=False):
 def polar(r,a):
  a=math.radians(a-90);return (r*math.cos(a),r*math.sin(a))
 def path(points,close=False):
  return '<path d="M'+' L'.join(f'{u:.5f},{v:.5f}' for u,v in points)+(' Z' if close else '')+'"/>'
 paths=[]
 # Eight identical facets, traced from the approved board and regularized.
 for i in range(8):
  a=i*45
  O=polar(100,a); Q=polar(76.536686,a+22.5); Qprev=polar(76.536686,a-22.5)
  J=polar(52,a); U=polar(30,a+22.5); Jnext=polar(52,a+45)
  paths.append(path([O,Q,J,Qprev],True))
  paths.append(path([J,U,Jnext]))
  if not micro: paths.append(path([O,J]))
 return f'<g transform="translate({x} {y}) scale({size/208})" fill="none" stroke="{c}" stroke-width="{4.6 if micro else 5.2}" stroke-linejoin="miter">'+''.join(paths)+'</g>'
def word(x,y,s,c=P):
 return f'<g transform="translate({x} {y}) scale({s})" fill="{c}"><path transform="scale(1 -1)" d="{g["E"]}"/><path transform="translate(135 20) scale(.52 -.52)" d="{g["8"]}"/></g>'
def lock(x,y,s,c=P,mc=L):return mark(x+72*s,y-61*s,144*s,mc)+word(x+170*s,y,s,c)
