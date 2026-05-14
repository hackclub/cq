var menubutton = document.getElementById("menubutton")
var mobilemenu = document.getElementById("mobilemenu")
var navbar = document.getElementById("navbar")
var menuopen = false

menubutton.addEventListener("click", function() {
  menuopen = !menuopen
  if (menuopen) {
    mobilemenu.classList.add("open")
    menubutton.classList.add("active")
  } else {
    mobilemenu.classList.remove("open")
    menubutton.classList.remove("active")
  }
})

var mobilelinks = mobilemenu.querySelectorAll("a")
for (var i = 0; i < mobilelinks.length; i++) {
  mobilelinks[i].addEventListener("click", function() {
    mobilemenu.classList.remove("open")
    menubutton.classList.remove("active")
    menuopen = false
  })
}

var allanchors = document.querySelectorAll('a[href^="#"]')
for (var i = 0; i < allanchors.length; i++) {
  allanchors[i].addEventListener("click", function(e) {
    var target = document.querySelector(this.getAttribute("href"))
    if (target) {
      e.preventDefault()
      var offset = navbar.offsetHeight + 10
      var top = target.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top: top, behavior: "smooth" })
    }
  })
}

var faqitems = document.querySelectorAll(".faqitem")
for (var i = 0; i < faqitems.length; i++) {
  faqitems[i].addEventListener("toggle", function() {
    if (this.open) {
      for (var j = 0; j < faqitems.length; j++) {
        if (faqitems[j] !== this && faqitems[j].open) {
          faqitems[j].open = false
        }
      }
    }
  })
}

var observer = new IntersectionObserver(function(entries) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].isIntersecting) {
      entries[i].target.classList.add("visible")
    }
  }
}, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" })

var sections = document.querySelectorAll("section, .featurecard, .licencecard, .faqitem")
for (var i = 0; i < sections.length; i++) {
  sections[i].classList.add("fadein")
  observer.observe(sections[i])
}
